// src/scene/renderer.js
// Factory functions for the Three.js scene graph primitives.
// No business logic — pure Three.js setup.
// All four functions are called once at startup from main.js.

import * as THREE from 'three';

// Initializes the WebGL renderer on the given canvas with antialiasing,
// device pixel ratio, and sRGB color space.
export function createRenderer(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(canvas.clientWidth, canvas.clientHeight);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    return renderer;
}

// Creates the scene with a dark navy background, ambient fill light,
// and a directional light from above to give tubes a sense of depth.
export function createScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a1a);

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambient);

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(50, 100, 50);
    scene.add(sun);

    return scene;
}

// Creates a perspective camera positioned at the default 3D view angle,
// looking at the origin where the subway map is centered.
export function createCamera(width, height) {
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
    camera.position.set(-28, 38, 44);
    camera.lookAt(0, 0, 0);
    return camera;
}

// Updates the renderer size and camera projection matrix to match the
// current window dimensions. Attach to window resize events in main.js.
export function onWindowResize(renderer, camera) {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
