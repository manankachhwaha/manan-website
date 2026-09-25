/* =========================================================
   Fluid — a small WebGL2 ink simulation (stable fluids).
   Fluid.init(canvas) -> true if the device supports it.
   Fluid.splat(x, y, dx, dy, [r,g,b])  x,y in 0..1 (y up)
   Fluid.step(dt) then Fluid.render()
   ========================================================= */
const Fluid = (() => {
  const small = matchMedia('(max-width: 700px), (pointer: coarse)').matches;
  const cfg = {
    SIM: small ? 64 : 128,
    DYE: small ? 256 : 640,
    DENSITY_DISSIPATION: 1.5,   // how fast ink fades (higher = never floods)
    VELOCITY_DISSIPATION: .25,
    PRESSURE: .8,
    ITER: small ? 8 : 18,
    CURL: 26,
    RADIUS: .22,
  };
  let gl, canvas, quad, P = {}, vel, dye, pressure, div, curl, simTex, ok = false;

  const VERT = `#version 300 es
  precision highp float;
  in vec2 aPos;
  uniform vec2 texel;
  out vec2 vUv, vL, vR, vT, vB;
  void main() {
    vUv = aPos * .5 + .5;
    vL = vUv - vec2(texel.x, 0.); vR = vUv + vec2(texel.x, 0.);
    vT = vUv + vec2(0., texel.y); vB = vUv - vec2(0., texel.y);
    gl_Position = vec4(aPos, 0., 1.);
  }`;
  const HEAD = `#version 300 es
  precision highp float; precision highp sampler2D;
  in vec2 vUv, vL, vR, vT, vB;
  out vec4 o;
  `;
  const FRAG = {
    clear: `uniform sampler2D uTex; uniform float value;
      void main() { o = value * texture(uTex, vUv); }`,
    splat: `uniform sampler2D uTarget; uniform float aspect, radius; uniform vec3 color; uniform vec2 point;
      void main() {
        vec2 p = vUv - point; p.x *= aspect;
        o = vec4(texture(uTarget, vUv).xyz + exp(-dot(p, p) / radius) * color, 1.);
      }`,
    advect: `uniform sampler2D uVel, uSrc; uniform vec2 simTexel; uniform float dt, dissipation;
      void main() {
        vec2 coord = vUv - dt * texture(uVel, vUv).xy * simTexel;
        o = texture(uSrc, coord) / (1. + dissipation * dt);
      }`,
    divergence: `uniform sampler2D uVel;
      void main() {
        float L = texture(uVel, vL).x, R = texture(uVel, vR).x;
        float T = texture(uVel, vT).y, B = texture(uVel, vB).y;
        vec2 C = texture(uVel, vUv).xy;
        if (vL.x < 0.) L = -C.x; if (vR.x > 1.) R = -C.x;
        if (vT.y > 1.) T = -C.y; if (vB.y < 0.) B = -C.y;
        o = vec4(.5 * (R - L + T - B), 0., 0., 1.);
      }`,
    curl: `uniform sampler2D uVel;
      void main() {
        float L = texture(uVel, vL).y, R = texture(uVel, vR).y;
        float T = texture(uVel, vT).x, B = texture(uVel, vB).x;
        o = vec4(.5 * (R - L - T + B), 0., 0., 1.);
      }`,
    vorticity: `uniform sampler2D uVel, uCurl; uniform float curl, dt;
      void main() {
        float L = texture(uCurl, vL).x, R = texture(uCurl, vR).x;
        float T = texture(uCurl, vT).x, B = texture(uCurl, vB).x, C = texture(uCurl, vUv).x;
        vec2 f = .5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
        f /= length(f) + .0001; f *= curl * C; f.y *= -1.;
        vec2 v = texture(uVel, vUv).xy + f * dt;
        o = vec4(clamp(v, -1000., 1000.), 0., 1.);
      }`,
    pressure: `uniform sampler2D uPressure, uDiv;
      void main() {
        float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
        float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
        o = vec4((L + R + B + T - texture(uDiv, vUv).x) * .25, 0., 0., 1.);
      }`,
    gradient: `uniform sampler2D uPressure, uVel;
      void main() {
        float L = texture(uPressure, vL).x, R = texture(uPressure, vR).x;
        float T = texture(uPressure, vT).x, B = texture(uPressure, vB).x;
        vec2 v = texture(uVel, vUv).xy - vec2(R - L, T - B);
        o = vec4(v, 0., 1.);
      }`,
    display: `uniform sampler2D uTex;
      void main() {
        vec3 c = 1. - exp(-texture(uTex, vUv).rgb * 2.2);   // soft tone-map, no blow-outs
        float a = max(c.r, max(c.g, c.b));
        o = vec4(c, a) * .9;                                // premultiplied alpha, slightly see-through
      }`,
  };

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(fragSrc) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, HEAD + fragSrc));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name;
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('fbo');
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  }
  function double(w, h) {
    let a = target(w, h), b = target(w, h);
    return {
      w, h,
      get read() { return a; },
      get write() { return b; },
      swap() { [a, b] = [b, a]; },
    };
  }
  function res(r) {
    let aspect = gl.drawingBufferWidth / gl.drawingBufferHeight;
    if (aspect < 1) aspect = 1 / aspect;
    const lo = Math.round(r), hi = Math.round(r * aspect);
    return gl.drawingBufferWidth > gl.drawingBufferHeight ? [hi, lo] : [lo, hi];
  }

  function bind(prog) { gl.useProgram(prog.p); return prog.u; }
  function tex(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t.tex); return unit; }
  function blit(t) {
    if (t) { gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.viewport(0, 0, t.w, t.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight); }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function buildTargets() {
    const [sw, sh] = res(cfg.SIM), [dw, dh] = res(cfg.DYE);
    vel = double(sw, sh);
    dye = double(dw, dh);
    pressure = double(sw, sh);
    div = target(sw, sh);
    curl = target(sw, sh);
    simTex = [1 / sw, 1 / sh];
  }

  function resize() {
    if (!ok) return;
    const dpr = (small ? .6 : Math.min(1.5, devicePixelRatio || 1));
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === w && canvas.height === h) return;
    canvas.width = w; canvas.height = h;
    buildTargets();
  }

  function init(c) {
    canvas = c;
    try {
      gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
      if (!gl) return false;
      if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return false;
      for (const k in FRAG) P[k] = program(FRAG[k]);
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.BLEND);
      ok = true;
      canvas.width = canvas.height = 0;
      resize();
      return true;
    } catch (e) {
      console.warn('Fluid disabled:', e.message);
      ok = false;
      return false;
    }
  }

  function splat(x, y, dx, dy, color) {
    if (!ok) return;
    const aspect = canvas.width / canvas.height;
    let u = bind(P.splat);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform1f(u.aspect, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, (cfg.RADIUS / 100) * (aspect > 1 ? aspect : 1));
    gl.uniform1i(u.uTarget, tex(0, vel.read));
    gl.uniform3f(u.color, dx, dy, 0);
    blit(vel.write); vel.swap();
    gl.uniform1i(u.uTarget, tex(0, dye.read));
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    blit(dye.write); dye.swap();
  }

  function step(dt) {
    if (!ok) return;
    let u;
    u = bind(P.curl);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform1i(u.uVel, tex(0, vel.read));
    blit(curl);

    u = bind(P.vorticity);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform1i(u.uVel, tex(0, vel.read));
    gl.uniform1i(u.uCurl, tex(1, curl));
    gl.uniform1f(u.curl, cfg.CURL);
    gl.uniform1f(u.dt, dt);
    blit(vel.write); vel.swap();

    u = bind(P.divergence);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform1i(u.uVel, tex(0, vel.read));
    blit(div);

    u = bind(P.clear);
    gl.uniform1i(u.uTex, tex(0, pressure.read));
    gl.uniform1f(u.value, cfg.PRESSURE);
    blit(pressure.write); pressure.swap();

    u = bind(P.pressure);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform1i(u.uDiv, tex(0, div));
    for (let i = 0; i < cfg.ITER; i++) {
      gl.uniform1i(u.uPressure, tex(1, pressure.read));
      blit(pressure.write); pressure.swap();
    }

    u = bind(P.gradient);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform1i(u.uPressure, tex(0, pressure.read));
    gl.uniform1i(u.uVel, tex(1, vel.read));
    blit(vel.write); vel.swap();

    u = bind(P.advect);
    gl.uniform2f(u.texel, simTex[0], simTex[1]);
    gl.uniform2f(u.simTexel, simTex[0], simTex[1]);
    gl.uniform1f(u.dt, dt);
    gl.uniform1i(u.uVel, tex(0, vel.read));
    gl.uniform1i(u.uSrc, tex(0, vel.read));
    gl.uniform1f(u.dissipation, cfg.VELOCITY_DISSIPATION);
    blit(vel.write); vel.swap();

    gl.uniform1i(u.uVel, tex(0, vel.read));
    gl.uniform1i(u.uSrc, tex(1, dye.read));
    gl.uniform1f(u.dissipation, cfg.DENSITY_DISSIPATION);
    blit(dye.write); dye.swap();
  }

  function render() {
    if (!ok) return;
    const u = bind(P.display);
    gl.uniform2f(u.texel, 1 / gl.drawingBufferWidth, 1 / gl.drawingBufferHeight);
    gl.uniform1i(u.uTex, tex(0, dye.read));
    blit(null);
  }

  return { init, splat, step, render, resize, get ok() { return ok; } };
})();
