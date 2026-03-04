let pc;
try {
  pc = require("../voxel_landmark/node_modules/playcanvas/build/playcanvas.js");
} catch (e) {
  pc = require("../voxel_landmark/node_modules/playcanvas");
}

console.log(pc.AnimCurve.prototype);
