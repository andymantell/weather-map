// n8ao ships without type declarations; this covers the parts the PoC uses.
declare module 'n8ao' {
  import type { Camera, Scene } from 'three';
  import { Pass } from 'three/addons/postprocessing/Pass.js';

  export class N8AOPass extends Pass {
    constructor(scene: Scene, camera: Camera, width?: number, height?: number);
    configuration: {
      aoRadius: number;
      distanceFalloff: number;
      intensity: number;
      gammaCorrection: boolean;
      [key: string]: unknown;
    };
    setQualityMode(mode: 'Performance' | 'Low' | 'Medium' | 'High' | 'Ultra'): void;
  }
}
