/**
 * A small HDF5 reader for NetCDF-4 files over HTTP range requests. It reads only the metadata it needs and the
 * chunks that overlap the requested window, so a browser can pull a crop of a Met Office UKV field straight from S3
 * without downloading the whole file.
 *
 * It covers what the Met Office writes: superblock v2/v3, version 2 object headers, groups with compact or dense
 * (fractal heap) links, chunked datasets indexed by a version 1 B-tree, and the deflate and shuffle filters.
 * Anything else throws with a clear message rather than returning wrong numbers.
 */

/** Fetches byte ranges of one file and counts what it transfers. */
export class RangeReader {
  /** Bytes received, including metadata. */
  bytes = 0;
  requests = 0;
  size = 0;
  private pages = new Map<number, Promise<Uint8Array>>();
  private extents: { start: number; data: Uint8Array }[] = [];

  constructor(
    readonly url: string,
    private pageSize = 16384,
  ) {}

  private async fetchRange(start: number, end: number, attempt = 0): Promise<Uint8Array> {
    let data: Uint8Array;
    try {
      const response = await fetch(this.url, { headers: { range: `bytes=${start}-${end - 1}` } });
      if (response.status === 404) throw new Error(`${this.url}: not found`);
      if (response.status !== 206) throw new Error(`${this.url}: expected 206 for a range read, got ${response.status}`);
      data = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      // Hundreds of requests per hour of data: retry dropped connections rather than lose the whole load.
      if (attempt >= 2 || String(error).includes('not found')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      return this.fetchRange(start, end, attempt + 1);
    }
    this.bytes += data.length;
    this.requests++;
    return data;
  }

  /**
   * Reads the head of the file, then the tail. The Met Office files keep their metadata in both places (the tail
   * holds headers rewritten when the file was closed), so this usually answers every metadata read. The file size
   * comes from the superblock rather than Content-Range, which the bucket's CORS rules do not expose. Plain
   * `bytes=a-b` ranges are CORS-safelisted, so none of this needs a preflight request.
   */
  async open(head = 16384, tail = 40960): Promise<void> {
    const a = await this.fetchRange(0, head);
    this.extents.push({ start: 0, data: a });
    // Superblock v2/v3: end-of-file address after the base and extension addresses.
    const view = new DataView(a.buffer);
    const offsetSize = view.getUint8(9);
    let size = 0;
    for (let i = 0; i < offsetSize; i++) size += view.getUint8(12 + 2 * offsetSize + i) * 2 ** (8 * i);
    this.size = size;
    const from = Math.max(a.length, size - tail);
    if (from < size) this.extents.push({ start: from, data: await this.fetchRange(from, size) });
  }

  /** Bytes [offset, offset + length) for metadata, served from the prefetched extents or cached pages. */
  async read(offset: number, length: number): Promise<DataView> {
    for (const { start, data } of this.extents) {
      if (offset >= start && offset + length <= start + data.length) {
        return new DataView(data.buffer, data.byteOffset + offset - start, length);
      }
    }
    const first = Math.floor(offset / this.pageSize);
    const last = Math.floor((offset + length - 1) / this.pageSize);
    const pages: Uint8Array[] = [];
    for (let p = first; p <= last; p++) {
      let page = this.pages.get(p);
      if (!page) {
        const end = this.size ? Math.min((p + 1) * this.pageSize, this.size) : (p + 1) * this.pageSize;
        page = this.fetchRange(p * this.pageSize, end);
        this.pages.set(p, page);
      }
      pages.push(await page);
    }
    if (pages.length === 1) {
      const at = offset - first * this.pageSize;
      return new DataView(pages[0].buffer, pages[0].byteOffset + at, length);
    }
    const joined = new Uint8Array(pages.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of pages) {
      joined.set(p, at);
      at += p.length;
    }
    return new DataView(joined.buffer, offset - first * this.pageSize, length);
  }

  /** Raw bytes for chunk data, fetched directly and not cached. */
  raw(start: number, end: number): Promise<Uint8Array> {
    return this.fetchRange(start, end);
  }
}

/** A cursor over a DataView, little-endian, with HDF5's variable-width offsets and lengths. */
class Cursor {
  constructor(
    public view: DataView,
    public pos = 0,
  ) {}
  u8() {
    return this.view.getUint8(this.pos++);
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  /** Unsigned integer of n bytes (up to 8; exact below 2^53). All ones reads as -1, HDF5's "undefined address". */
  uint(n: number) {
    let v = 0;
    let ones = true;
    for (let i = 0; i < n; i++) {
      const b = this.view.getUint8(this.pos + i);
      if (b !== 0xff) ones = false;
      v += b * 2 ** (8 * i);
    }
    this.pos += n;
    return ones ? -1 : v;
  }
  bytes(n: number) {
    const out = new Uint8Array(this.view.buffer, this.view.byteOffset + this.pos, n);
    this.pos += n;
    return out;
  }
  sig(expected: string) {
    const s = String.fromCharCode(...this.bytes(4));
    if (s !== expected) throw new Error(`HDF5: expected ${expected}, found ${JSON.stringify(s)}`);
  }
  skip(n: number) {
    this.pos += n;
  }
  get remaining() {
    return this.view.byteLength - this.pos;
  }
}

interface Message {
  type: number;
  data: DataView;
}

export interface Dataset {
  name: string;
  shape: number[];
  /** 'f4', 'f8', 'i4' and so on. */
  dtype: string;
  littleEndian: boolean;
  layout:
    | { kind: 'chunked'; btree: number; chunk: number[] }
    | { kind: 'contiguous'; address: number; size: number }
    | { kind: 'compact'; data: Uint8Array };
  filters: number[];
  fillValue?: number;
  /** Selected attributes, numeric or string. */
  attributes: Record<string, number | string | number[]>;
}

interface Chunk {
  offset: number[];
  address: number;
  size: number;
  filterMask: number;
}

const MSG = {
  dataspace: 0x01,
  linkInfo: 0x02,
  datatype: 0x03,
  fillValue: 0x05,
  link: 0x06,
  layout: 0x08,
  filters: 0x0b,
  attribute: 0x0c,
  continuation: 0x10,
} as const;

const FILTER_DEFLATE = 1;
const FILTER_SHUFFLE = 2;

export class Hdf5File {
  private offsetSize = 8;
  private lengthSize = 8;
  private root = 0;
  private datasets?: Map<string, number>;

  private constructor(readonly reader: RangeReader) {}

  static async open(url: string): Promise<Hdf5File> {
    const reader = new RangeReader(url);
    await reader.open();
    const file = new Hdf5File(reader);
    await file.readSuperblock();
    return file;
  }

  private async readSuperblock() {
    const c = new Cursor(await this.reader.read(0, 48));
    const sig = c.bytes(8);
    if (sig[0] !== 0x89 || String.fromCharCode(...sig.subarray(1, 4)) !== 'HDF') throw new Error('Not an HDF5 file');
    const version = c.u8();
    if (version !== 2 && version !== 3) throw new Error(`HDF5 superblock version ${version} is not supported`);
    this.offsetSize = c.u8();
    this.lengthSize = c.u8();
    c.skip(1); // flags
    const base = c.uint(this.offsetSize);
    if (base !== 0) throw new Error('HDF5 base address other than 0 is not supported');
    c.skip(this.offsetSize * 2); // superblock extension, end of file
    this.root = c.uint(this.offsetSize);
  }

  /** All messages in the object header at `address`, following continuation blocks. */
  private async messages(address: number): Promise<Message[]> {
    // An object header is small; read generously and trust the chunk size field.
    let c = new Cursor(await this.reader.read(address, 16));
    c.sig('OHDR');
    if (c.u8() !== 2) throw new Error('Only version 2 object headers are supported');
    const flags = c.u8();
    if (flags & 0x20) c.skip(16);
    if (flags & 0x10) c.skip(4);
    const sizeBytes = 1 << (flags & 3);
    const prefix = c.pos + sizeBytes;
    c = new Cursor(await this.reader.read(address, prefix), c.pos);
    const chunk0 = c.uint(sizeBytes);
    const out: Message[] = [];
    const blocks: { address: number; length: number; start: number; continuation: boolean }[] = [
      { address, length: prefix + chunk0, start: prefix, continuation: false },
    ];
    while (blocks.length) {
      const block = blocks.shift()!;
      const view = await this.reader.read(block.address, block.length);
      const m = new Cursor(view);
      if (block.continuation) m.sig('OCHK');
      else m.pos = block.start;
      const header = 4 + (flags & 0x04 ? 2 : 0);
      while (m.remaining >= header) {
        const type = m.u8();
        const size = m.u16();
        m.skip(1); // message flags
        if (flags & 0x04) m.skip(2);
        if (size > m.remaining) break;
        const data = new DataView(view.buffer, view.byteOffset + m.pos, size);
        m.skip(size);
        if (type === MSG.continuation) {
          const cc = new Cursor(data);
          const at = cc.uint(this.offsetSize);
          const length = cc.uint(this.lengthSize);
          // Continuation blocks end with a 4-byte checksum, which is not a message.
          blocks.push({ address: at, length: length - 4, start: 4, continuation: true });
        } else {
          out.push({ type, data });
        }
      }
    }
    return out;
  }

  /** Names and object header addresses of everything in the root group. */
  async list(): Promise<Map<string, number>> {
    if (this.datasets) return this.datasets;
    const links = new Map<string, number>();
    for (const msg of await this.messages(this.root)) {
      if (msg.type === MSG.link) {
        const link = this.parseLink(new Cursor(msg.data));
        if (link) links.set(link.name, link.address);
      } else if (msg.type === MSG.linkInfo) {
        const c = new Cursor(msg.data);
        c.skip(1);
        const flags = c.u8();
        if (flags & 1) c.skip(8);
        const heap = c.uint(this.offsetSize);
        const nameIndex = c.uint(this.offsetSize);
        if (heap !== -1) for (const [name, address] of await this.denseLinks(heap, nameIndex)) links.set(name, address);
      }
    }
    this.datasets = links;
    return links;
  }

  private parseLink(c: Cursor): { name: string; address: number } | undefined {
    if (c.u8() !== 1) throw new Error('Unknown link message version');
    const flags = c.u8();
    const type = flags & 0x08 ? c.u8() : 0;
    if (flags & 0x04) c.skip(8);
    if (flags & 0x10) c.skip(1);
    const nameLength = c.uint(1 << (flags & 3));
    const name = new TextDecoder().decode(c.bytes(nameLength));
    if (type !== 0) return undefined; // soft and external links are not followed
    return { name, address: c.uint(this.offsetSize) };
  }

  /** Links stored in a fractal heap, found through the version 2 B-tree name index. */
  private async denseLinks(heapAddress: number, btreeAddress: number): Promise<[string, number][]> {
    const O = this.offsetSize;
    const L = this.lengthSize;
    const h = new Cursor(await this.reader.read(heapAddress, 4 + 1 + 2 + 2 + 1 + 4 + L + O + L + O + 8 * L + 2 + L + L + 2 + 2 + O + 2));
    h.sig('FRHP');
    h.skip(1);
    const idLength = h.u16();
    const filtersLength = h.u16();
    if (filtersLength) throw new Error('Filtered fractal heaps are not supported');
    const heapFlags = h.u8();
    const maxManaged = h.u32();
    h.skip(L + O + L + O + 8 * L);
    h.skip(2); // table width
    h.skip(L); // starting block size
    const maxDirect = h.uint(L);
    const maxHeapBits = h.u16();
    h.skip(2);
    const rootBlock = h.uint(O);
    const rows = h.u16();
    if (rows !== 0) throw new Error('Fractal heaps with an indirect root block are not supported');
    const offsetBytes = Math.ceil(maxHeapBits / 8);
    const bytesFor = (v: number) => Math.ceil(Math.log2(v + 1) / 8);
    const lengthBytes = Math.min(bytesFor(maxDirect), bytesFor(maxManaged));

    // B-tree v2 header, then its root, which for a handful of links is a single leaf.
    const t = new Cursor(await this.reader.read(btreeAddress, 4 + 2 + 4 + 2 + 2 + 2 + O + 2 + L));
    t.sig('BTHD');
    t.skip(1);
    const type = t.u8();
    if (type !== 5) throw new Error(`Unexpected B-tree v2 type ${type} for link names`);
    const nodeSize = t.u32();
    const recordSize = t.u16();
    const depth = t.u16();
    t.skip(2);
    const rootNode = t.uint(O);
    const records = t.u16();
    if (depth !== 0) throw new Error('Link name B-trees deeper than one leaf are not supported');
    const leaf = new Cursor(await this.reader.read(rootNode, Math.min(nodeSize, 6 + records * recordSize)));
    leaf.sig('BTLF');
    leaf.skip(2);
    const ids: Uint8Array[] = [];
    for (let i = 0; i < records; i++) {
      leaf.skip(4); // name hash
      ids.push(leaf.bytes(idLength).slice());
      leaf.skip(recordSize - 4 - idLength);
    }

    const blockHeader = 4 + 1 + O + offsetBytes + (heapFlags & 2 ? 4 : 0);
    const out: [string, number][] = [];
    for (const id of ids) {
      const c = new Cursor(new DataView(id.buffer));
      const kind = (c.u8() >> 4) & 3;
      if (kind !== 0) throw new Error('Only managed fractal heap objects are supported');
      const offset = c.uint(offsetBytes);
      const length = c.uint(lengthBytes);
      if (offset < blockHeader) throw new Error('Bad fractal heap offset');
      const link = this.parseLink(new Cursor(await this.reader.read(rootBlock + offset, length)));
      if (link) out.push([link.name, link.address]);
    }
    return out;
  }

  /** Metadata for one dataset in the root group. */
  async dataset(name: string): Promise<Dataset> {
    const address = (await this.list()).get(name);
    if (address === undefined) throw new Error(`No dataset ${name}`);
    const ds: Dataset = { name, shape: [], dtype: '', littleEndian: true, layout: undefined!, filters: [], attributes: {} };
    let elementSize = 0;
    let fillBytes: DataView | undefined;
    for (const { type, data } of await this.messages(address)) {
      const c = new Cursor(data);
      if (type === MSG.dataspace) {
        ds.shape = this.parseDataspace(c);
      } else if (type === MSG.datatype) {
        const t = this.parseDatatype(c);
        ds.dtype = t.dtype;
        ds.littleEndian = t.littleEndian;
        elementSize = t.size;
      } else if (type === MSG.layout) {
        ds.layout = this.parseLayout(c);
      } else if (type === MSG.filters) {
        ds.filters = this.parseFilters(c);
      } else if (type === MSG.fillValue) {
        const version = c.u8();
        if (version === 3) {
          const flags = c.u8();
          if (flags & 0x20) fillBytes = new DataView(data.buffer, data.byteOffset + c.pos + 4, c.u32());
        } else if (version === 2) {
          c.skip(2);
          if (c.u8()) fillBytes = new DataView(data.buffer, data.byteOffset + c.pos + 4, c.u32());
        }
      } else if (type === MSG.attribute) {
        const attr = this.parseAttribute(c);
        if (attr) ds.attributes[attr.name] = attr.value;
      }
    }
    if (!ds.layout) throw new Error(`${name}: no data layout`);
    if (fillBytes && fillBytes.byteLength === elementSize) ds.fillValue = readElement(fillBytes, 0, ds.dtype, ds.littleEndian);
    return ds;
  }

  private parseDataspace(c: Cursor): number[] {
    const version = c.u8();
    const rank = c.u8();
    c.skip(version === 1 ? 6 : 2);
    return Array.from({ length: rank }, () => c.uint(this.lengthSize));
  }

  private parseDatatype(c: Cursor): { dtype: string; size: number; littleEndian: boolean } {
    const classVersion = c.u8();
    const cls = classVersion & 0x0f;
    const bits = c.u8();
    c.skip(2);
    const size = c.u32();
    const littleEndian = (bits & 1) === 0;
    if (cls === 1) return { dtype: `f${size}`, size, littleEndian };
    if (cls === 0) return { dtype: `${bits & 0x08 ? 'i' : 'u'}${size}`, size, littleEndian };
    if (cls === 3) return { dtype: 'S', size, littleEndian };
    return { dtype: `class${cls}`, size, littleEndian };
  }

  private parseLayout(c: Cursor): Dataset['layout'] {
    const version = c.u8();
    if (version !== 3) throw new Error(`Data layout version ${version} is not supported`);
    const kind = c.u8();
    if (kind === 0) return { kind: 'compact', data: c.bytes(c.u16()).slice() };
    if (kind === 1) return { kind: 'contiguous', address: c.uint(this.offsetSize), size: c.uint(this.lengthSize) };
    if (kind === 2) {
      const rank = c.u8();
      const btree = c.uint(this.offsetSize);
      const dims = Array.from({ length: rank }, () => c.u32());
      return { kind: 'chunked', btree, chunk: dims.slice(0, -1) };
    }
    throw new Error(`Data layout class ${kind} is not supported`);
  }

  private parseFilters(c: Cursor): number[] {
    const version = c.u8();
    const n = c.u8();
    if (version === 1) c.skip(6);
    const ids: number[] = [];
    for (let i = 0; i < n; i++) {
      const id = c.u16();
      const nameLength = version === 1 || id >= 256 ? c.u16() : 0;
      c.skip(2); // flags
      const values = c.u16();
      c.skip(version === 1 ? Math.ceil(nameLength / 8) * 8 : nameLength);
      c.skip(values * 4);
      if (version === 1 && values % 2) c.skip(4);
      ids.push(id);
    }
    return ids;
  }

  /** Attributes with numeric or fixed-length string values; others are skipped. */
  private parseAttribute(c: Cursor): { name: string; value: number | string | number[] } | undefined {
    const version = c.u8();
    if (version !== 3 && version !== 1) return undefined;
    c.skip(1);
    const nameSize = c.u16();
    const typeSize = c.u16();
    const spaceSize = c.u16();
    if (version === 3) c.skip(1);
    const pad = (n: number) => (version === 1 ? Math.ceil(n / 8) * 8 : n);
    const name = new TextDecoder().decode(c.bytes(nameSize)).replace(/\0+$/, '');
    c.skip(pad(nameSize) - nameSize);
    const type = this.parseDatatype(new Cursor(c.view, c.pos));
    c.skip(pad(typeSize));
    const shape = this.parseDataspace(new Cursor(c.view, c.pos));
    c.skip(pad(spaceSize));
    const count = shape.reduce((a, b) => a * b, 1);
    if (type.dtype === 'S') {
      return { name, value: new TextDecoder().decode(c.bytes(type.size * count)).replace(/\0+$/, '') };
    }
    if (!/^[fiu]\d$/.test(type.dtype) || c.remaining < count * type.size) return undefined;
    const values = Array.from({ length: count }, (_, i) =>
      readElement(c.view, c.pos + i * type.size, type.dtype, type.littleEndian),
    );
    return { name, value: count === 1 ? values[0] : values };
  }

  /** Every chunk of a chunked dataset, from its version 1 B-tree. */
  async chunks(ds: Dataset): Promise<Chunk[]> {
    if (ds.layout.kind !== 'chunked') throw new Error(`${ds.name} is not chunked`);
    const rank = ds.shape.length;
    const O = this.offsetSize;
    const keySize = 8 + 8 * (rank + 1);
    const out: Chunk[] = [];
    const visit = async (address: number): Promise<void> => {
      const head = new Cursor(await this.reader.read(address, 8 + 2 * O));
      head.sig('TREE');
      const nodeType = head.u8();
      const level = head.u8();
      const entries = head.u16();
      if (nodeType !== 1) throw new Error('Expected a raw-data chunk B-tree');
      const c = new Cursor(await this.reader.read(address + 8 + 2 * O, entries * (keySize + O) + keySize));
      const children: number[] = [];
      for (let i = 0; i < entries; i++) {
        const size = c.u32();
        const filterMask = c.u32();
        const offset = Array.from({ length: rank }, () => c.uint(8));
        c.skip(8);
        const child = c.uint(O);
        if (level === 0) out.push({ offset, address: child, size, filterMask });
        else children.push(child);
      }
      await Promise.all(children.map(visit));
    };
    await visit(ds.layout.btree);
    return out;
  }

  /**
   * Reads the hyperslab start[i] .. start[i] + count[i] of a numeric dataset into a Float32Array (C order).
   * Only the chunks that overlap it are fetched, with neighbouring chunks merged into one request when the gap
   * between them is under `mergeGap` bytes.
   */
  async readSlab(ds: Dataset, start: number[], count: number[], mergeGap = 16384): Promise<Float32Array> {
    const rank = ds.shape.length;
    const out = new Float32Array(count.reduce((a, b) => a * b, 1));
    if (ds.layout.kind === 'compact' || ds.layout.kind === 'contiguous') {
      let bytes: Uint8Array;
      if (ds.layout.kind === 'compact') bytes = ds.layout.data;
      else {
        // Small coordinate arrays usually sit in the prefetched metadata, so go through the metadata cache.
        const view = await this.reader.read(ds.layout.address, ds.layout.size);
        bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
      }
      copyBlock(decode(bytes, ds), ds.shape, new Array(rank).fill(0), out, start, count);
      return out;
    }
    const chunkShape = ds.layout.chunk;
    const wanted = (await this.chunks(ds))
      .filter((ch) => ch.offset.every((o, i) => o < start[i] + count[i] && o + chunkShape[i] > start[i]))
      .sort((a, b) => a.address - b.address);

    // Merge chunks that sit close together in the file into single range requests.
    const groups: Chunk[][] = [];
    for (const ch of wanted) {
      const g = groups[groups.length - 1];
      const last = g?.[g.length - 1];
      if (last && ch.address - (last.address + last.size) <= mergeGap) g.push(ch);
      else groups.push([ch]);
    }
    await Promise.all(
      groups.map(async (g) => {
        const from = g[0].address;
        const bytes = await this.reader.raw(from, g[g.length - 1].address + g[g.length - 1].size);
        await Promise.all(
          g.map(async (ch) => {
            let data = bytes.subarray(ch.address - from, ch.address - from + ch.size);
            const filters = ds.filters.filter((_, i) => !(ch.filterMask & (1 << i)));
            for (const id of [...filters].reverse()) {
              if (id === FILTER_DEFLATE) data = await inflate(data);
              else if (id === FILTER_SHUFFLE) data = unshuffle(data, Number(ds.dtype.slice(1)));
              else throw new Error(`HDF5 filter ${id} is not supported`);
            }
            copyBlock(decode(data, ds), chunkShape, ch.offset, out, start, count);
          }),
        );
      }),
    );
    return out;
  }
}

function readElement(view: DataView, at: number, dtype: string, le: boolean): number {
  switch (dtype) {
    case 'f4':
      return view.getFloat32(at, le);
    case 'f8':
      return view.getFloat64(at, le);
    case 'i1':
      return view.getInt8(at);
    case 'u1':
      return view.getUint8(at);
    case 'i2':
      return view.getInt16(at, le);
    case 'u2':
      return view.getUint16(at, le);
    case 'i4':
      return view.getInt32(at, le);
    case 'u4':
      return view.getUint32(at, le);
    case 'i8':
      return Number(view.getBigInt64(at, le));
    case 'u8':
      return Number(view.getBigUint64(at, le));
  }
  throw new Error(`Unsupported data type ${dtype}`);
}

function decode(bytes: Uint8Array, ds: Dataset): Float32Array {
  const size = Number(ds.dtype.slice(1));
  const n = Math.floor(bytes.length / size);
  if (ds.dtype === 'f4' && ds.littleEndian && bytes.byteOffset % 4 === 0) {
    return new Float32Array(bytes.buffer, bytes.byteOffset, n);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = readElement(view, i * size, ds.dtype, ds.littleEndian);
  return out;
}

/** Copies the part of a block (origin `at`, shape `shape`) that falls in the window into `out`. */
function copyBlock(src: Float32Array, shape: number[], at: number[], out: Float32Array, start: number[], count: number[]) {
  const rank = shape.length;
  const lo = at.map((a, i) => Math.max(a, start[i]));
  const hi = at.map((a, i) => Math.min(a + shape[i], start[i] + count[i]));
  if (lo.some((l, i) => l >= hi[i])) return;
  const srcStride = new Array(rank).fill(1);
  const dstStride = new Array(rank).fill(1);
  for (let i = rank - 2; i >= 0; i--) {
    srcStride[i] = srcStride[i + 1] * shape[i + 1];
    dstStride[i] = dstStride[i + 1] * count[i + 1];
  }
  const run = hi[rank - 1] - lo[rank - 1];
  const idx = lo.slice(0, -1);
  for (;;) {
    let s = lo[rank - 1] - at[rank - 1];
    let d = lo[rank - 1] - start[rank - 1];
    for (let i = 0; i < rank - 1; i++) {
      s += (idx[i] - at[i]) * srcStride[i];
      d += (idx[i] - start[i]) * dstStride[i];
    }
    out.set(src.subarray(s, s + run), d);
    let k = rank - 2;
    while (k >= 0 && ++idx[k] >= hi[k]) idx[k] = lo[k--];
    if (k < 0) break;
  }
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function unshuffle(data: Uint8Array, size: number): Uint8Array {
  const n = Math.floor(data.length / size);
  const out = new Uint8Array(data.length);
  for (let b = 0; b < size; b++) for (let i = 0; i < n; i++) out[i * size + b] = data[b * n + i];
  out.set(data.subarray(n * size), n * size);
  return out;
}
