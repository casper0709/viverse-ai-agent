import { AnimTrack, AnimData, AnimCurve, AnimEvents } from '../voxel_landmark/node_modules/playcanvas/build/playcanvas.mjs';

const inputs = [new AnimData(1, [0, 1, 2])];
const outputs = [new AnimData(3, [0, 0, 0, 1, 1, 1, 2, 2, 2])];
const curves = [new AnimCurve(["myNode", "translation"], 0, 0, 1)];

const track = new AnimTrack("test", 2.0, inputs, outputs, curves, new AnimEvents([]));

console.log(track.curves[0].paths);
