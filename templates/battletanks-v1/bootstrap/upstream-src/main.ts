import { World } from "./World/World";

interface CustomWindow extends Window {
  world: any;
}

declare let window: CustomWindow;

function main() {
  const world = new World();
  window.world = world;
}

main();
