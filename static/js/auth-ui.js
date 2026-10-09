// Attendance Monitor - user bar, change-password dialog and (developer) user management.
// Wrapped in an IIFE so it never clashes with the globals in app.js.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TABS = [['daily', 'Daily Report'], ['matrix', 'Status Matrix'],
                ['inactive', 'Inactive Employees'], ['summary', 'Overall Summary'],
                ['punchin', 'Dashboard & Punch Reports']];
  const BUSINESSES = ['MAGNUS', 'ALIMS', 'M&D', 'MERCHX', 'HU', 'GRANDIS'];
  let me = null;

  async function call(method, url, body) {
    const res = await fetch(url, {
      method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    });
    if (res.status === 401) { location.href = '/login'; throw new Error('Session expired.'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- modal helper ----------
  function openModal(title, html, { wide = false, closable = true } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h2>${esc(title)}</h2>${closable ? '<button class="modal-x" aria-label="Close">&times;</button>' : ''}</div>
      <div class="modal-body">${html}</div></div>`;
    document.body.appendChild(back);
    const close = () => back.remove();
    if (closable) {
      back.querySelector('.modal-x').onclick = close;
      back.addEventListener('mousedown', e => { if (e.target === back) close(); });
    }
    return { el: back, body: back.querySelector('.modal-body'), close };
  }

  // ---------- user bar ----------
  function renderUserBar() {
    const bar = $('userbar');
    if (!bar) return;
    $('userIdentity').innerHTML = `Signed in as <strong>${esc(me.display_name || me.username)}</strong> <span class="role-badge ${esc(me.role)}">${esc(me.role)}${me.role === 'business' ? ' · ' + esc(me.business) : ''}</span>`;
    const userMenuControl = $('userMenuControl');
    const userMenu = $('userMenu');
    const userMenuToggle = $('userMenuToggle');
    userMenuControl?.classList.remove('hidden');
    userMenuToggle?.addEventListener('click', () => {
      const isOpen = !userMenu.classList.contains('hidden');
      userMenu.classList.toggle('hidden', isOpen);
      userMenuToggle.setAttribute('aria-expanded', String(!isOpen));
    });
    document.addEventListener('click', event => {
      if (userMenuControl && !userMenuControl.contains(event.target)) {
        userMenu.classList.add('hidden');
        userMenuToggle?.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        userMenu.classList.add('hidden');
        userMenuToggle?.setAttribute('aria-expanded', 'false');
      }
    });
    const usersButton = $('sidebarUsers');
    if (usersButton) {
      usersButton.classList.toggle('hidden', me.role !== 'developer');
      usersButton.onclick = openUsers;
    }
    const syncSection = $('developerSyncSection');
    syncSection?.classList.toggle('hidden', me.role !== 'developer');
    const syncToggle = $('syncSectionToggle');
    const syncOptions = $('syncSectionOptions');
    if (syncToggle && syncOptions) {
      syncToggle.onclick = () => {
        const expanded = syncToggle.getAttribute('aria-expanded') === 'true';
        syncToggle.setAttribute('aria-expanded', String(!expanded));
        syncOptions.hidden = expanded;
      };
    }
    const syncArchive = $('syncArchive');
    const syncFetchData = $('syncFetchData');
    if (syncArchive) syncArchive.onclick = () => window.runDeveloperSyncAction?.('archive');
    if (syncFetchData) syncFetchData.onclick = () => window.runDeveloperSyncAction?.('fetch');
    const syncFetchDays = $('syncFetchDays');
    if (syncFetchDays) syncFetchDays.onclick = () => window.openFetchDaysSettings?.();
    $('ubPw').onclick = () => {
      userMenu.classList.add('hidden');
      userMenuToggle?.setAttribute('aria-expanded', 'false');
      openChangePassword(false);
    };
    $('ubOut').onclick = async () => {
      userMenu.classList.add('hidden');
      try { await call('POST', '/api/logout'); } catch (e) { /* ignore */ }
      location.href = '/login';
    };
  }

  // ---------- change password ----------
  function openChangePassword(forced) {
    const m = openModal(forced ? 'Set a new password' : 'Change password', `
      ${forced ? '<p class="hint-text">You must choose a new password before continuing.</p>' : ''}
      <div id="cpErr" class="form-error hidden"></div>
      <label>Current password<input id="cpOld" type="password" autocomplete="current-password"></label>
      <label>New password<input id="cpNew" type="password" autocomplete="new-password"></label>
      <label>Confirm new password<input id="cpNew2" type="password" autocomplete="new-password"></label>
      <p class="hint-text">At least 8 characters, with a letter and a number.</p>
      <div class="modal-actions">
        ${forced ? '<button class="btn-small" id="cpOut">Logout</button>' : '<button class="btn-small" id="cpCancel">Cancel</button>'}
        <button class="btn-small primary" id="cpSave">Save password</button>
      </div>`, { closable: !forced });
    const err = m.body.querySelector('#cpErr');
    const fail = t => { err.textContent = t; err.classList.remove('hidden'); };
    if (forced) m.body.querySelector('#cpOut').onclick = async () => { await call('POST', '/api/logout'); location.href = '/login'; };
    else m.body.querySelector('#cpCancel').onclick = m.close;
    m.body.querySelector('#cpSave').onclick = async () => {
      err.classList.add('hidden');
      const cur = m.body.querySelector('#cpOld').value, n1 = m.body.querySelector('#cpNew').value,
            n2 = m.body.querySelector('#cpNew2').value;
      if (!cur || !n1) return fail('Fill in all fields.');
      if (n1 !== n2) return fail('The new passwords do not match.');
      try {
        await call('POST', '/api/change-password', { current_password: cur, new_password: n1 });
        if (forced) return location.reload();
        m.body.innerHTML = '<div class="form-ok">Password changed.</div><div class="modal-actions"><button class="btn-small primary" id="cpDone">OK</button></div>';
        m.body.querySelector('#cpDone').onclick = m.close;
      } catch (e) { fail(e.message); }
    };
  }

  // ---------- users & access (developer) ----------
  function genPassword() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
    const buf = new Uint32Array(12);
    crypto.getRandomValues(buf);
    let pw = Array.from(buf, n => chars[n % chars.length]).join('');
    return pw.slice(0, 10) + 'a7';
  }

  function permSummary(u) {
    if (u.role !== 'business') return 'Full access';
    const p = u.permissions;
    return `${p.tabs.length}/4 windows · PDF ${p.download ? 'yes' : 'no'} · date ${p.change_date ? 'yes' : 'no'}`;
  }

  async function openUsers() {
    const m = openModal('Users & Access', '<div id="uList">Loading…</div><div id="uForm"></div>', { wide: true });
    const listEl = m.body.querySelector('#uList'), formEl = m.body.querySelector('#uForm');
    let users = [];

    async function refresh() {
      try { users = await call('GET', '/api/users'); } catch (e) { listEl.innerHTML = `<div class="form-error">${esc(e.message)}</div>`; return; }
      listEl.innerHTML = `<div class="modal-actions" style="justify-content:space-between;align-items:center">
          <span class="hint-text">${users.length} user(s)</span>
          <button class="btn-small primary" id="uAdd">+ Add user</button></div>
        <table class="users-table"><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Business</th><th>Access</th><th>Status</th><th></th></tr></thead><tbody>
        ${users.map(u => `<tr>
          <td>${esc(u.username)}</td><td>${esc(u.display_name)}</td>
          <td><span class="role-badge ${esc(u.role)}">${esc(u.role)}</span></td>
          <td>${esc(u.business || (u.role === 'business' ? '' : 'All'))}</td>
          <td>${esc(permSummary(u))}</td>
          <td>${u.active ? 'Active' : '<span class="tag-off">Disabled</span>'}${u.must_change_password ? ' · must change pw' : ''}</td>
          <td class="act"><button class="btn-small" data-edit="${esc(u.username)}">Edit</button>
            ${u.username === me.username ? '' : `<button class="btn-small danger" data-del="${esc(u.username)}">Delete</button>`}</td></tr>`).join('')}
        </tbody></table>`;
      listEl.querySelector('#uAdd').onclick = () => showForm(null);
      listEl.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => showForm(users.find(u => u.username === b.dataset.edit)));
      listEl.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
        if (!confirm(`Delete user "${b.dataset.del}"? This cannot be undone.`)) return;
        try { await call('DELETE', '/api/users/' + encodeURIComponent(b.dataset.del)); formEl.innerHTML = ''; refresh(); }
        catch (e) { alert(e.message); }
      });
    }

    function showForm(u) {
      const editing = !!u;
      const perms = u ? u.permissions : { download: true, change_date: false, tabs: TABS.map(t => t[0]) };
      formEl.innerHTML = `<div class="user-form">
        <h3>${editing ? 'Edit ' + esc(u.username) : 'Add user'}</h3>
        <div id="ufErr" class="form-error hidden full"></div>
        <label>Username<input id="ufUser" type="text" autocapitalize="none" value="${esc(u ? u.username : '')}" ${editing ? 'disabled' : ''}></label>
        <label>Display name<input id="ufName" type="text" value="${esc(u ? u.display_name : '')}"></label>
        <label>Role<select id="ufRole">
          ${['developer', 'admin', 'business'].map(r => `<option value="${r}" ${u && u.role === r ? 'selected' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}
        </select></label>
        <label id="ufBizWrap">Business<select id="ufBiz">
          ${BUSINESSES.map(b => `<option value="${esc(b)}" ${u && u.business === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}
        </select></label>
        <div class="perm-box full" id="ufPerms">
          <strong style="font-size:.85rem">Business user access</strong>
          <label class="check-row"><input type="checkbox" id="ufDl" ${perms.download ? 'checked' : ''}> Can download PDFs</label>
          <label class="check-row"><input type="checkbox" id="ufDate" ${perms.change_date ? 'checked' : ''}> Can change the date (otherwise latest day only)</label>
          <div class="check-group">${TABS.map(([k, l]) => `<label class="check-row"><input type="checkbox" data-tab="${k}" ${perms.tabs.includes(k) ? 'checked' : ''}> ${l}</label>`).join('')}</div>
        </div>
        <label class="full">${editing ? 'New password (leave blank to keep the current one)' : 'Initial password'}
          <span class="pw-row"><input id="ufPw" type="text" autocomplete="off" placeholder="${editing ? 'unchanged' : ''}">
          <button type="button" class="btn-small" id="ufGen">Generate</button></span></label>
        <label class="check-row"><input type="checkbox" id="ufForce" ${!editing || u.must_change_password ? 'checked' : ''}> Must change password at next login</label>
        ${editing ? `<label class="check-row"><input type="checkbox" id="ufActive" ${u.active ? 'checked' : ''}> Account active</label>` : ''}
        <div class="modal-actions full"><button class="btn-small" id="ufCancel">Cancel</button><button class="btn-small primary" id="ufSave">${editing ? 'Save changes' : 'Create user'}</button></div>
      </div>`;
      const f = id => formEl.querySelector('#' + id);
      const sync = () => {
        const biz = f('ufRole').value === 'business';
        f('ufBizWrap').classList.toggle('hidden', !biz);
        f('ufPerms').classList.toggle('hidden', !biz);
      };
      f('ufRole').onchange = sync; sync();
      f('ufGen').onclick = () => { f('ufPw').value = genPassword(); };
      f('ufCancel').onclick = () => { formEl.innerHTML = ''; };
      f('ufSave').onclick = async () => {
        const err = f('ufErr'); err.classList.add('hidden');
        const body = {
          display_name: f('ufName').value.trim(), role: f('ufRole').value, business: f('ufBiz').value,
          permissions: {
            download: f('ufDl').checked, change_date: f('ufDate').checked,
            tabs: [...formEl.querySelectorAll('[data-tab]')].filter(c => c.checked).map(c => c.dataset.tab)
          },
          must_change_password: f('ufForce').checked
        };
        if (f('ufPw').value) body.password = f('ufPw').value;
        try {
          if (editing) { body.active = f('ufActive').checked; await call('PUT', '/api/users/' + encodeURIComponent(u.username), body); }
          else { body.username = f('ufUser').value.trim(); await call('POST', '/api/users', body); }
          formEl.innerHTML = ''; refresh();
        } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); }
      };
      formEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    refresh();
  }

  window.AuthUI = {
    init(user) { me = user; renderUserBar(); if (me.must_change_password) openChangePassword(true); },
    forcePasswordChange() { if (!document.querySelector('.modal-back')) openChangePassword(true); }
  };
})();