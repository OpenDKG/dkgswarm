// Join page behaviour (moved out of an inline script so the CSP needs no 'unsafe-inline').
function copyText(text) {
  function fallbackCopy() {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const copied = document.execCommand('copy');
    ta.remove();
    if (!copied) throw new Error('Copy failed');
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).catch(fallbackCopy);
  }
  fallbackCopy();
  return Promise.resolve();
}
function showCopied(button) {
  const label = button.dataset.label || button.textContent.trim();
  button.dataset.label = label;
  button.textContent = 'Copied';
  button.classList.add('is-copied');
  window.setTimeout(() => {
    button.textContent = label;
    button.classList.remove('is-copied');
  }, 1800);
}
function copyWithFeedback(button, text) {
  copyText(text)
    .then(() => showCopied(button))
    .catch(() => {
      const label = button.dataset.label || button.textContent.trim();
      button.dataset.label = label;
      button.textContent = 'Copy failed';
      window.setTimeout(() => { button.textContent = label; }, 1800);
    });
}
function showTab(name, moveFocus) {
  document.querySelectorAll('.join-tab').forEach(t => {
    const on = t.getAttribute('data-tab') === name;
    t.classList.toggle('is-active', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.setAttribute('tabindex', on ? '0' : '-1');
    if (on && moveFocus) t.focus();
  });
  document.querySelectorAll('.join-playbook').forEach(p => {
    const on = p.id === 'tab-' + name;
    p.classList.toggle('is-active', on);
    p.hidden = !on;
  });
  if (history.replaceState) history.replaceState(null, '', '#' + name);
}
function wireJoin() {
  const hamburger = document.getElementById('hamburger');
  const navLinks = document.getElementById('nav-links');
  if (hamburger && navLinks) {
    hamburger.addEventListener('click', () => {
      hamburger.classList.toggle('active');
      navLinks.classList.toggle('active');
      const open = navLinks.classList.contains('active');
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
      hamburger.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    });
    navLinks.querySelectorAll('a').forEach(link => {
      link.addEventListener('click', () => {
        hamburger.classList.remove('active');
        navLinks.classList.remove('active');
        hamburger.setAttribute('aria-expanded', 'false');
        hamburger.setAttribute('aria-label', 'Open menu');
      });
    });
  }
  const tabs = Array.from(document.querySelectorAll('.join-tab'));
  tabs.forEach((t, index) => {
    t.addEventListener('click', () => showTab(t.getAttribute('data-tab')));
    t.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      let next = index;
      if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      showTab(tabs[next].getAttribute('data-tab'), true);
    });
  });
  const hash = (location.hash || '#grok').replace('#','');
  const allowed = ['grok','claude','chatgpt','cursor','more'];
  showTab(allowed.includes(hash) ? hash : 'grok');
  if (hash === 'update-existing') {
    history.replaceState(null, '', '#' + hash);
    document.getElementById(hash).scrollIntoView();
  }
  document.querySelectorAll('.copy-chip').forEach(el => {
    el.addEventListener('click', () => {
      const t = el.getAttribute('data-copy');
      copyWithFeedback(el, t);
    });
  });
  const grokBox = document.getElementById('start-prompt');
  const appPromptPrefixes = {
    claude: `Use Claude in browser. Connect DKG Swarm remote MCP at https://www.dkgswarm.com/mcp; if you cannot add it, give me exact connector settings steps. Preserve my approvals and ask before enabling schedule.\n\n`,
    chatgpt: `Connect DKG Swarm custom MCP at https://www.dkgswarm.com/mcp. If you cannot add it, give me exact connector settings steps. Ask before enabling a scheduled task.\n\n`,
    codex: `Use Codex. Connect DKG Swarm remote MCP at https://www.dkgswarm.com/mcp with OAuth; if you cannot add it, give me exact CLI steps. Verify scheduling, MCP access during scheduled execution, and authorized X access in the actual runtime before promising automation; if scheduling is unavailable, use the guidance manually.\n\n`
  };
  document.getElementById('copy-start').addEventListener('click', () => {
    const button = document.getElementById('copy-start');
    copyWithFeedback(button, grokBox.value);
  });
  document.getElementById('copy-update').addEventListener('click', () => {
    copyWithFeedback(document.getElementById('copy-update'), document.getElementById('update-prompt').value);
  });
  document.querySelectorAll('.copy-shared').forEach(btn => {
    btn.addEventListener('click', () => copyWithFeedback(btn, grokBox.value));
  });
  document.querySelectorAll('.copy-app').forEach(btn => {
    btn.addEventListener('click', () => {
      const prefix = appPromptPrefixes[btn.dataset.prompt] || '';
      copyWithFeedback(btn, prefix + grokBox.value);
    });
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireJoin);
else wireJoin();
