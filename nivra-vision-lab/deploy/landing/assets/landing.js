/* Motion engine adapted from mono-premium-web/assets/starter.html.
   All libraries and media are local. This page never connects to a camera or guard. */
(() => {
  'use strict';
  const root = document.documentElement;
  const nav = document.getElementById('nav');
  const story = document.querySelector('.story');
  const phoneBeat = document.querySelector('.phone-beat');
  const thumb = document.querySelector('.slider-thumb');
  const slider = document.querySelector('.stop-slider');
  const status = document.querySelector('.phone-status');
  const label = document.querySelector('.slider-label');
  const stopped = document.querySelector('.slider-stopped');
  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');

  // Never read or send the secret itself. Only check whether a pairing exists.
  try {
    if (localStorage.getItem('nivra.guard.secret')) {
      document.getElementById('paired-banner').hidden = false;
      root.classList.add('has-paired');
    }
  } catch { /* Browsing with storage disabled must not block the page. */ }


  let sliderTween;
  let manuallyStopped = false;
  function setRingState(quiet) {
    phoneBeat.classList.toggle('is-silenced', quiet);
    status.textContent = quiet ? 'Stopped. Ready to review.' : 'Ringing for your attention';
    thumb.setAttribute('aria-label', quiet ? 'Example ring stopped' : 'Stop the example ring');
  }
  thumb.addEventListener('click', () => {
    if (manuallyStopped) return;
    manuallyStopped = true;
    if (sliderTween) sliderTween.kill();
    setRingState(true);
    if (window.gsap && !reduceQuery.matches) {
      gsap.to(thumb, { x: slider.clientWidth - thumb.offsetWidth - 8, duration: .4, ease: 'power2.inOut' });
      gsap.to(label, { opacity: 0, duration: .2 });
      gsap.to(stopped, { opacity: 1, duration: .2, delay: .2 });
    } else {
      thumb.style.transform = `translateX(${slider.clientWidth - thumb.offsetWidth - 8}px)`;
      label.style.opacity = '0';
      stopped.style.opacity = '1';
    }
  });

  if (!window.gsap || !window.ScrollTrigger || !window.SplitText || !window.Lenis) {
    root.classList.remove('js');
    return;
  }
  gsap.registerPlugin(ScrollTrigger, SplitText);
  gsap.defaults({ duration: .65, ease: 'expo.out' });
  const mm = gsap.matchMedia();

  document.fonts.ready.then(() => {
    mm.add({ motion: '(prefers-reduced-motion: no-preference)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
      root.classList.add('motion-ready');
      root.classList.remove('js');
      if (context.conditions.reduce) return;
      let lenis;
      let tick;
      const splits = [];
      if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
        lenis = new Lenis({ lerp: .1, smoothWheel: true, anchors: { offset: -80 } });
        lenis.on('scroll', ScrollTrigger.update);
        tick = t => lenis.raf(t * 1000);
        gsap.ticker.add(tick);
        gsap.ticker.lagSmoothing(0);
      }
      story.classList.add('is-animated');
      const skeleton = document.querySelector('.skeleton');
      const posePaths = [...skeleton.querySelectorAll('path')];
      const outline = document.querySelector('.alert-outline');
      const score = document.getElementById('demo-score');
      const cameraState = document.getElementById('camera-state');
      const steps = [...document.querySelectorAll('[data-step]')];
      const scoreValue = { value: 0 };
      gsap.set([skeleton, '.fight-label', '.scene-confirm'], { opacity: 0 });
      posePaths.forEach(path => { path.style.strokeDasharray = path.getTotalLength(); path.style.strokeDashoffset = path.getTotalLength(); });
      gsap.set(outline, { strokeDasharray: 1, strokeDashoffset: 1, opacity: 0 });
      gsap.set('.scene-phone', { y: 110, opacity: 0, rotation: 6 });
      const states = ['Two people at the gate', 'Understanding movement', 'Possible fight. Alerting your guard.', 'Asha · on scene'];
      let currentStage = -1;
      // Pin created before all later triggers, so they measure its extra space.
      const sequence = gsap.timeline({ defaults: { ease: 'none' }, scrollTrigger: {
        id: 'four-seconds', trigger: '.story-pin', start: 'top top',
        end: () => '+=' + Math.round(innerHeight * (innerWidth <= 760 ? 1.5 : 2)),
        pin: true, scrub: .35, invalidateOnRefresh: true,
        onUpdate(self) {
          const p = self.progress;
          const stage = p < .18 ? 0 : p < .36 ? 1 : p < .81 ? 2 : 3;
          if (stage !== currentStage) {
            currentStage = stage;
            cameraState.textContent = states[stage];
            steps.forEach((el, i) => el.classList.toggle('is-current', i === stage));
          }
        }
      }});
      sequence.addLabel('see', 0)
        .to({}, { duration: .45 }, 0)
        .addLabel('understand', .45)
        .to(skeleton, { opacity: 1, duration: .25 }, 'understand')
        .to(posePaths, { strokeDashoffset: 0, duration: .5 }, 'understand')
        .addLabel('alert', 1.2)
        .to(outline, { opacity: 1, strokeDashoffset: 0, duration: .5 }, 'alert')
        .to('.fight-label', { opacity: 1, duration: .25 }, 'alert+=.3')
        .to(scoreValue, { value: 92, duration: .6, onUpdate: () => { score.textContent = Math.round(scoreValue.value); } }, 'alert+=.3')
        .addLabel('ring', 2.15)
        .to('.scene-phone', { y: 0, opacity: 1, rotation: 0, duration: .6, ease: 'power2.inOut' }, 'ring')
        .to('.story-camera .camera-bottom>span:last-child', { opacity: 0, duration: .2 }, 'ring')
        .addLabel('respond', 3.25)
        .to('.scene-confirm', { opacity: 1, duration: .3 }, 'respond')
        .to('.scene-phone .ring-state', { opacity: 0, duration: .2 }, 'respond')
        .to({}, { duration: .45 }, 3.55);

      const heroSplit = SplitText.create('.hero h1', { type: 'lines', mask: 'lines', linesClass: 'split-line' });
      splits.push(heroSplit);
      const intro = gsap.timeline();
      intro.from(heroSplit.lines, { yPercent: 110, duration: .65, stagger: .07 }, 0)
        .from('.hero-description', { opacity: 0, y: 12, duration: .5 }, .65)
        .from('.hero-actions', { opacity: 0, y: 12, duration: .5 }, .8);
      gsap.fromTo('.hero-camera', { scale: .975 }, { scale: 1, ease: 'none', scrollTrigger: { trigger: '.hero-media', start: 'top 90%', end: 'top 10%', scrub: true } });
      // Heading masks are individual, once-only reveals. Never replay on the way up.
      document.querySelectorAll('h2[data-split]').forEach(el => {
        const split = SplitText.create(el, { type: 'lines', mask: 'lines', linesClass: 'split-line' });
        splits.push(split);
        gsap.from(split.lines, { yPercent: 110, duration: .65, stagger: .06, scrollTrigger: { trigger: el, start: 'top 94%', once: true } });
      });

      manuallyStopped = false;
      setRingState(false);
      sliderTween = gsap.timeline({ scrollTrigger: { id: 'phone-slider', trigger: '.hero-phone', start: 'top 70%', end: 'bottom 52%', scrub: true,
        onUpdate(self) { if (!manuallyStopped) setRingState(self.progress > .87); }
      }}).fromTo(thumb, { x: 0 }, { x: () => slider.clientWidth - thumb.offsetWidth - 8, ease: 'none', duration: 1 })
        .to(label, { opacity: 0, duration: .3 }, .3)
        .to(stopped, { opacity: 1, duration: .2 }, .8);
      gsap.to('.clip-playhead', { x: () => document.querySelector('.filmstrip').clientWidth - 8, ease: 'none', scrollTrigger: { trigger: '.clip-editor', start: 'top 80%', end: 'bottom 35%', scrub: true, invalidateOnRefresh: true } });
      const privacySplit = SplitText.create('[data-scrub]', { type: 'words' });
      splits.push(privacySplit);
      gsap.fromTo(privacySplit.words, { opacity: .22 }, { opacity: 1, ease: 'none', stagger: .1, scrollTrigger: { trigger: '.privacy-statement', start: 'top 78%', end: 'bottom 50%', scrub: true } });
      document.querySelectorAll('[data-clip]').forEach(el => {
        gsap.fromTo(el, { clipPath: 'inset(100% 0% 0% 0% round 20px)' }, { clipPath: 'inset(0% 0% 0% 0% round 20px)', duration: .7, scrollTrigger: { trigger: el, start: 'top 86%', once: true } });
      });
      const cameraLine = document.querySelector('.camera-line path');
      const cameraLength = cameraLine.getTotalLength();
      gsap.fromTo(cameraLine, { strokeDasharray: cameraLength, strokeDashoffset: cameraLength }, { strokeDashoffset: 0, ease: 'none', scrollTrigger: { trigger: '.payoff', start: 'top 80%', end: 'top 30%', scrub: true } });
      gsap.from('.footer', { clipPath: 'inset(0 100% 0 0)', duration: .6, scrollTrigger: { trigger: '.footer', start: 'top 98%', once: true } });
      let lastNavY = 0;
      ScrollTrigger.create({ start: 0, end: 'max', onUpdate(self) {
        const y = self.scroll();
        if (Math.abs(y - lastNavY) < 6) return;
        nav.classList.toggle('is-hidden', self.direction === 1 && y > 180);
        lastNavY = y;
      }});
      ScrollTrigger.refresh();
      return () => {
        if (lenis) lenis.destroy();
        if (tick) gsap.ticker.remove(tick);
        splits.forEach(split => split.revert());
        posePaths.forEach(path => { path.style.strokeDasharray = ''; path.style.strokeDashoffset = ''; });
        story.classList.remove('is-animated');
        phoneBeat.classList.remove('is-silenced');
        nav.classList.remove('is-hidden');
        cameraState.textContent = 'Two people at the gate';
        score.textContent = '92';
        setRingState(false);
      };
    });
    window.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
  }).catch(() => {
    mm.revert();
    root.classList.remove('js');
    story.classList.remove('is-animated');
  });
})();
