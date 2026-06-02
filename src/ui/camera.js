// src/ui/camera.js
// Camera controls, smooth tweening, and 2D/3D view presets.
// OrbitControls handles mouse/touch input; tweenTo drives all programmatic movement.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// Attaches OrbitControls to the camera with damping and distance limits.
// Call controls.update() each frame in the animation loop.
export function initOrbitControls(camera, domElement) {
    const controls = new OrbitControls(camera, domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 5;
    controls.maxDistance = 300;
    return controls;
}

// Smoothly animates the camera position and look target over durationMs
// using an ease-in-out quadratic curve. Used by setView and station fly-to.
export function tweenTo(camera, controls, targetPos, targetLook, durationMs = 900) {
    const startPos = camera.position.clone();
    const startLook = controls.target.clone();
    const endPos = new THREE.Vector3(...targetPos);
    const endLook = new THREE.Vector3(...targetLook);
    const start = performance.now();

    function animate() {
        const raw = Math.min((performance.now() - start) / durationMs, 1);
        const t = raw < 0.5 ? 2 * raw * raw : -1 + (4 - 2 * raw) * raw;

        camera.position.lerpVectors(startPos, endPos, t);
        controls.target.lerpVectors(startLook, endLook, t);
        controls.update();

        if (raw < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
}

// Tweens the camera to the 2D top-down preset or the 3D perspective preset.
// Positions and targets match the README spec.
export function setView(camera, controls, mode) {
    if (mode === '2d') {
        tweenTo(camera, controls, [0, 75, 0.01], [0, 0, 0]);
    } else {
        tweenTo(camera, controls, [-28, 38, 44], [0, 0, 0]);
    }
}
