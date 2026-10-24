'use strict';

/** The footer of every page: the contact address comes from the server's settings (REIM_CONTACT_EMAIL), not the code;
 * the version is the server's (package.json). */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/site.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const { contact, version } = await response.json();
    if (typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version)) {
      const note = Object.assign(document.createElement('span'), { id: 'footer-version', className: 'version', textContent: `v${version}` });
      document.querySelector('.site-footer p')?.append(note);
    }
    if (typeof contact !== 'string' || !contact) return;
    const link = document.getElementById('footer-email');
    link.textContent = contact;
    link.href = `mailto:${contact}`;
    document.getElementById('footer-contact').hidden = false;
  } catch { /* no contact shown */ }
});
