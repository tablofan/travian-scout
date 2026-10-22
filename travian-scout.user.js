// ==UserScript==
// @name         TS32 Scout sender
// @namespace    https://tablofan.github.io/travian-scout/
// @version      1.0
// @description  Sends the scouts picked on the TS32 Alliance Scout page: presses Send, then Confirm, one target at a time.
// @match        https://ts32.x3.international.travian.com/*
// @match        https://tablofan.github.io/travian-scout/*
// @run-at       document-start
// @grant        none
// @updateURL    https://tablofan.github.io/travian-scout/travian-scout.user.js
// @downloadURL  https://tablofan.github.io/travian-scout/travian-scout.user.js
// ==/UserScript==

// The scout page's Send opens a game tab whose hash holds a job: the villages to send from, in the order to try
// them, the targets with their scout counts, and the scouting report wanted. The script works through the targets
// in that tab, one at a time. Each goes from the first village with enough scouts home. It stops at anything it
// didn't expect: a confirm page that would send anything but that many scouts, from that village, to that target.
(() => {
  "use strict";
  const SITE = "https://tablofan.github.io";  // only jobs from the scout page are taken
  const VERSION = "1.0";
  const JOB = "travian-scout-job", BUSY = "travian-scout-busy";
  const CLICK = [400, 1200], PAUSE = [1500, 3500], WAIT = 15000;  // ms: before a click, between sends, for a page

  // On the scout page, only say the script is here, so the page can offer Send.
  if (location.origin === SITE) {
    const mark = () => { document.documentElement.dataset.scoutSender = VERSION; document.dispatchEvent(new Event("scout-sender")); };
    if (document.documentElement) mark(); else document.addEventListener("readystatechange", mark, { once: true });  // too early for <html>
    return;
  }

  const rand = ([a, b]) => a + Math.random() * (b - a);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const BIDI = /[‎‏‪-‮⁦-⁩]/g;  // the game wraps numbers in direction marks
  const num = s => parseInt(String(s ?? "").replace(BIDI, "").replace(/−/g, "-").replace(/[^\d-]/g, ""), 10);
  const whole = (n, lo, hi) => Number.isInteger(n) && n >= lo && n <= hi;
  const load = () => { try { return JSON.parse(sessionStorage.getItem(JOB)); } catch { return null; } };
  const save = job => sessionStorage.setItem(JOB, JSON.stringify(job));
  const target = job => job.queue[job.i];
  const village = job => job.vils[job.vi];
  const xy = ([x, y]) => `(${x}|${y})`;
  const sendUrl = job => {
    const [x, y, n] = target(job);
    return `/build.php?newdid=${village(job).did}&gid=16&tt=2&eventType=4&x=${x}&y=${y}&troop%5Bt4%5D=${n}`;
  };
  // The first village, in order, that may have n scouts home: not known to have fewer. -1 when none.
  const firstWith = (job, n) => job.vils.findIndex(v => !(job.home[v.did] < n));
  const said = () => {
    const words = [...document.querySelectorAll("#build .error, #build .alert, #build .errorMessage")].map(e => e.textContent.trim()).filter(Boolean);
    return words.length ? `: the game says ${words.join("; ")}` : "";
  };

  // ── the job, read from the link before the game's own scripts run ──
  let note = "";
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.has("travian-scout")) {
    history.replaceState(null, "", location.pathname + location.search);  // a reload must not start it again
    let from = ""; try { from = new URL(document.referrer).origin; } catch { /* no referrer */ }
    let j = null; try { j = JSON.parse(h.get("travian-scout")); } catch { /* not a job */ }
    const vils = Array.isArray(j?.v) && j.v.every(v => Array.isArray(v) && whole(v[0], 1, 1e9) && typeof v[1] === "string")
      ? j.v.map(([did, name]) => ({ did, name: name.slice(0, 40) })) : [];
    const queue = Array.isArray(j?.t) && j.t.every(t => Array.isArray(t) && whole(t[0], -200, 200) && whole(t[1], -200, 200) && whole(t[2], 1, 1e6))
      ? j.t.map(([x, y, n]) => [x, y, n]) : [];
    if (from !== SITE) note = "Not started: that link didn't come from the scout page.";
    else if (!vils.length || vils.length > 50 || !queue.length || queue.length > 300 || !["", "1", "2"].includes(j.s ?? "")) note = "Not started: the link's job doesn't make sense.";
    else save({ vils, queue, spy: j.s || "", i: 0, vi: 0, home: {}, step: "send", loads: 0, sent: [], skipped: [] });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run();

  function run() {
    if (note) return bar(note, [["OK", () => bar()]]);
    const job = load(); if (!job) return;
    ({ send: sendStep, confirm: confirmStep, after: afterStep, failed: showFail })[job.step]?.(job);
  }

  // ── one send: the form, its confirm page, and the page after ──
  async function sendStep(job) {
    const [x, y, n] = target(job), from = village(job);
    const form = document.querySelector("form[action*='tt=2']");
    const at = name => num(form?.querySelector(`input[name='${name}']`)?.value);
    if (!form || document.querySelector("#troopSendForm") || at("x") !== x || at("y") !== y) {
      if (++job.loads > 2) return fail(job, `The send form for ${xy([x, y])} didn't load.`);
      save(job); return location.assign(sendUrl(job));
    }
    // enough scouts home here? If not, the next village that may have them
    const t4 = form.querySelector("input[name='troop[t4]']");
    if (!t4) return fail(job, "The send form has no scout field.");
    const home = t4.disabled ? 0 : num(((t4.closest("td")?.textContent || "").replace(BIDI, "").match(/\/\s*(\d[\d,.]*)/) || [])[1]);
    if (Number.isNaN(home)) return fail(job, "Couldn't read how many scouts are home.");
    job.home[from.did] = home;
    if (home < n) {
      const vi = firstWith(job, n);
      if (vi < 0) { job.skipped.push([x, y, `no village has ${n} scouts home`]); return next(job); }
      bar(`${from.name} has ${home} scouts home, not ${n}; trying ${job.vils[vi].name}…`, [["Stop", () => stop(job)]]);
      job.vi = vi; job.loads = 0; save(job);
      await sleep(rand(CLICK));
      return location.assign(sendUrl(job));
    }
    // only scouts, as many as asked, as a raid
    for (const el of form.querySelectorAll("input[name^='troop[']")) {
      const want = el.name === "troop[t4]" ? n : 0;
      if ((num(el.value) || 0) !== want) return fail(job, `The form has ${el.value || 0} in ${el.name}, not ${want}.`);
    }
    const raid = form.querySelector("input[name=eventType][value='4']"), ok = form.querySelector("#ok");
    if (!raid || !ok) return fail(job, "The send form has no Raid option or Send button.");
    raid.click();
    if (!raid.checked) return fail(job, "The Raid option wouldn't tick.");
    await myTurn(job);
    if (!load()) return bar();  // stopped while waiting
    job.step = "confirm"; save(job);
    show(job, "sending");
    await sleep(rand(CLICK));
    ok.click();
    watch(() => document.querySelector("#troopSendForm #confirmSendTroops"), () => confirmStep(load()), "No confirm page came after Send");
  }

  async function confirmStep(job) {
    if (!job) return;
    const form = document.querySelector("form#troopSendForm"), ok = form?.querySelector("#confirmSendTroops");
    if (!ok) return fail(job, `The game didn't show the confirm page${said()}.`);
    const val = name => form.querySelector(`input[type=hidden][name='${name}']`)?.value;
    const [x, y, n] = target(job), from = village(job), troops = {};
    for (const el of form.querySelectorAll("input[type=hidden][name^='troops[0][t']")) {
      const c = num(el.value) || 0;
      if (c) troops[el.name.slice(10, -1)] = c;
    }
    const units = Object.keys(troops), wrong = [];
    if (!["3", "4", "6"].includes(val("eventType"))) wrong.push(`it isn't a raid or attack (event ${val("eventType")})`);
    if (units.length !== 1 || troops.t4 !== n) wrong.push(`it sends ${units.map(u => `${troops[u]} ${u}`).join(", ") || "nothing"}, not ${n} t4`);
    if (num(val("x")) !== x || num(val("y")) !== y) wrong.push(`it goes to (${val("x")}|${val("y")}), not ${xy([x, y])}`);
    if (num(val("troops[0][villageId]")) !== from.did) wrong.push(`it leaves from village ${val("troops[0][villageId]")}, not ${from.name} (${from.did}); logged in as Minerva?`);
    if (wrong.length) return fail(job, `Not confirmed: ${wrong.join("; ")}.`);
    if (job.spy) {
      const kinds = [...form.querySelectorAll("input[type=radio]")].filter(r => /scout|spy/i.test(r.name));
      const pick = kinds.find(r => r.value === job.spy);
      if (kinds.length && !pick) return fail(job, "The confirm page has no such scouting report choice.");
      pick?.click();
    }
    show(job, "confirming");
    job.step = "after"; save(job);
    await sleep(rand(CLICK));
    ok.click();
    watch(() => !document.querySelector("#confirmSendTroops"), () => afterStep(load()), "The confirm page stayed after Confirm");
  }

  async function afterStep(job) {
    if (!job) return;
    if (document.querySelector("form#troopSendForm, form[action*='tt=2'] input[name^='troop[']")) return fail(job, `After Confirm the game showed a send form again${said()}.`);
    localStorage.setItem(BUSY, Date.now() + rand(PAUSE));  // the next send, from any tab, waits a moment
    const [x, y, n] = target(job), from = village(job);
    job.home[from.did] -= n;
    job.sent.push([x, y, from.name]);
    next(job);
  }

  // The next target that some village may have the scouts for; the ones none has are skipped without a page load.
  function next(job) {
    job.step = "send"; job.loads = 0;
    for (;;) {
      if (++job.i >= job.queue.length) return finish(job);
      const [x, y, n] = target(job), vi = firstWith(job, n);
      if (vi >= 0) { job.vi = vi; break; }
      job.skipped.push([x, y, `no village has ${n} scouts home`]);
    }
    save(job); show(job, "next");
    location.assign(sendUrl(job));
  }

  // One send at a time across tabs: wait while another tab is between Send and Confirm, or just sent.
  async function myTurn(job) {
    for (;;) {
      if (Date.now() > (+localStorage.getItem(BUSY) || 0)) { localStorage.setItem(BUSY, Date.now() + 3 * WAIT); return; }
      show(job, "waiting"); await sleep(rand([300, 900]));
    }
  }

  async function watch(done, then, why) {
    const end = Date.now() + WAIT;
    while (Date.now() < end) { await sleep(250); if (done()) return then(); }
    const job = load(); if (job) fail(job, `${why}${said()}.`);
  }

  // ── what the tab shows ──
  function fail(job, why) {
    localStorage.removeItem(BUSY);
    job.step = "failed"; job.why = why; save(job);
    showFail(job);
  }
  function showFail(job) {
    const [x, y] = target(job);
    bar(`Target ${job.i + 1} of ${job.queue.length}, ${xy([x, y])}: ${job.why}`, [
      ["Skip it and go on", () => { job.skipped.push([x, y, job.why]); next(job); }],
      ["Stop", () => stop(job)],
    ], true);
  }
  function show(job, what) {
    const doing = { waiting: "waiting for the other tab", confirming: "confirming", next: "on to it" }[what] || "sending";
    const [x, y, n] = target(job);
    bar(`Target ${job.i + 1} of ${job.queue.length}: ${n} scouts from ${village(job).name} to ${xy([x, y])}, ${doing}…`, [["Stop", () => stop(job)]]);
  }
  function stop(job) {
    sessionStorage.removeItem(JOB); localStorage.removeItem(BUSY);
    bar(`Stopped. ${summary(job)}`, [["OK", () => bar()]]);
  }
  function finish(job) {
    sessionStorage.removeItem(JOB);
    bar(`Done. ${summary(job)}`, [["OK", () => bar()]], job.skipped.length > 0);
  }
  function summary(job) {
    const by = new Map();
    for (const [, , name] of job.sent) by.set(name, (by.get(name) || 0) + 1);
    const from = by.size ? ` (${[...by].map(([name, c]) => `${c} from ${name}`).join(", ")})` : "";
    const skipped = job.skipped.length ? ` Skipped ${job.skipped.map(([x, y, why]) => `${xy([x, y])}: ${why.replace(/\.$/, "")}`).join("; ")}.` : "";
    return `Scouts went to ${job.sent.length} of ${job.queue.length} targets${from}.${skipped}`;
  }
  function bar(text, buttons = [], bad = false) {
    document.getElementById("travian-scout-bar")?.remove();
    if (!text) return;
    const el = document.createElement("div");
    el.id = "travian-scout-bar";
    el.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;padding:8px 14px;font:14px/1.4 system-ui,sans-serif;color:#fff;background:${bad ? "#9b1c1c" : "#1f4d3a"};box-shadow:0 2px 6px rgba(0,0,0,.3)`;
    const span = document.createElement("span"); span.textContent = text; span.style.flex = "1"; el.append(span);
    for (const [label, act] of buttons) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label;
      b.style.cssText = "font:inherit;padding:3px 10px;border:1px solid #fff;border-radius:4px;background:transparent;color:#fff;cursor:pointer";
      b.addEventListener("click", act); el.append(b);
    }
    document.body.append(el);
  }
})();
