import { Clock } from "three";
import { Camera } from "./Camera";
import { Renderer } from "./Renderer";
import { Scene } from "./Scene";

class Loop {
  scene: Scene;
  cameras: Camera[];
  renderers: Renderer[];
  clock: Clock;
  /// list of lists of updateables
  updatableLists: any[];

  constructor(scene: Scene, cameras: Camera[], renderers: Renderer[]) {
    this.scene = scene;
    this.cameras = cameras;
    this.renderers = renderers;
    this.clock = new Clock();
    this.updatableLists = [];
  }

  start() {
    for (let i = 0; i < this.cameras.length; i++) {
      const camera = this.cameras[i];
      const renderer = this.renderers[i];
      renderer.renderer.setAnimationLoop(() => {
        this.tick();
        renderer.renderer.render(this.scene.scene, camera.camera);
    });
    this.clock.getDelta();
  }}

  tick() {
    const delta = this.clock.getDelta();
    this.updatableLists.forEach(updatableList => { updatableList.forEach(updatable => updatable.tick(delta)) });
  }

  stop() {
    this.renderers.forEach(renderer => renderer.renderer.setAnimationLoop(null));
  }
}

export { Loop };
