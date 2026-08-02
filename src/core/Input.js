import * as THREE from 'three';

/**
 * Pointer + keyboard state, and the ground-plane raycast that every ARPG
 * click-to-move interaction is built on.
 *
 * Exposes edge-triggered (`pressed`) and level-triggered (`down`) queries so
 * gameplay code never has to track its own key latches.
 */
export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.ndc = new THREE.Vector2();       // pointer in normalized device coords
    this.screen = new THREE.Vector2();    // pointer in css pixels
    this.ground = new THREE.Vector3();    // pointer projected onto y=0
    this.groundValid = false;

    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this._down = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this._wheel = 0;

    this.mouse = { left: false, right: false, middle: false };
    this._mousePressed = { left: false, right: false, middle: false };
    this._mouseReleased = { left: false, right: false, middle: false };

    /** Set by UI layers so world clicks don't fire through panels. */
    this.pointerOverUI = false;

    this._bind();
  }

  _bind() {
    const el = this.canvas;

    addEventListener('keydown', (e) => {
      const k = e.code;
      if (!this._down.has(k)) this._pressed.add(k);
      this._down.add(k);
      // Stop the browser hijacking gameplay keys.
      if (['Space', 'Tab', 'F1', 'F2', 'F3'].includes(k)) e.preventDefault();
    });

    addEventListener('keyup', (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
    });

    addEventListener('blur', () => {
      this._down.clear();
      this.mouse.left = this.mouse.right = this.mouse.middle = false;
    });

    const btn = (i) => (i === 0 ? 'left' : i === 1 ? 'middle' : 'right');

    el.addEventListener('pointerdown', (e) => {
      const b = btn(e.button);
      if (!this.mouse[b]) this._mousePressed[b] = true;
      this.mouse[b] = true;
      el.setPointerCapture?.(e.pointerId);
      this._updatePointer(e);
    });

    addEventListener('pointerup', (e) => {
      const b = btn(e.button);
      this.mouse[b] = false;
      this._mouseReleased[b] = true;
    });

    addEventListener('pointermove', (e) => this._updatePointer(e));

    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      this._wheel += Math.sign(e.deltaY);
      e.preventDefault();
    }, { passive: false });
  }

  _updatePointer(e) {
    const r = this.canvas.getBoundingClientRect();
    this.screen.set(e.clientX - r.left, e.clientY - r.top);
    this.ndc.set(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  }

  /** Project the pointer onto the world ground plane. Call once per frame. */
  updateGround(camera, planeY = 0) {
    this._plane.constant = -planeY;
    this._raycaster.setFromCamera(this.ndc, camera);
    this.groundValid = !!this._raycaster.ray.intersectPlane(this._plane, this.ground);
    return this.ground;
  }

  raycaster(camera) {
    this._raycaster.setFromCamera(this.ndc, camera);
    return this._raycaster;
  }

  down(code) { return this._down.has(code); }
  pressed(code) { return this._pressed.has(code); }
  released(code) { return this._released.has(code); }

  mouseDown(b = 'left') { return this.mouse[b]; }
  mousePressed(b = 'left') { return this._mousePressed[b]; }
  mouseReleased(b = 'left') { return this._mouseReleased[b]; }

  get wheel() { return this._wheel; }

  /** Clear edge-triggered state. Must run at the very end of the frame. */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this._mousePressed.left = this._mousePressed.right = this._mousePressed.middle = false;
    this._mouseReleased.left = this._mouseReleased.right = this._mouseReleased.middle = false;
    this._wheel = 0;
  }
}
