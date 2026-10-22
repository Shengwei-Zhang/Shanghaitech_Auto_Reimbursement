'use strict';

/** The footer of every page: the contact address comes from the server's settings (REIM_CONTACT_EMAIL), not the code. */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const response = await fetch('/site.json', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
    const { contact } = await response.json();
    if (typeof contact !== 'string' || !contact) return;
    const link = document.getElementById('footer-email');
    link.textContent = contact;
    link.href = `mailto:${contact}`;
    document.getElementById('footer-contact').hidden = false;
  } catch { /* no contact shown */ }
});
