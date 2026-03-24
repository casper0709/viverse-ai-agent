import * as THREE from "three";
import { BaseObject } from "../object/BaseObject";

class Scene {
  scene: THREE.Scene;

  constructor() {
    this.scene = new THREE.Scene();
  }

  add(object: BaseObject) {
    if (object.mesh) {
      this.scene.add(object.mesh);
    }
  }
}

export { Scene };
