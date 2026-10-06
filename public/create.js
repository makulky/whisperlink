import { encryptSecret } from './crypto.js';

const $ = (id) => document.getElementById(id);
const form = $('create-form');
const errorEl = $('create-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorEl.hidden = true;
  const text = $('secret').value;
  const password = $('password').value;
  if (!text.trim()) return;

  const btn = $('create-btn');
  btn.disabled = true;
  btn.textContent = 'Cifrando…';
  try {
    const { key, payload } = await encryptSecret(text, password);
    const res = await fetch('/api/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ttl: $('ttl').value }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);

    $('link').value = `${location.origin}/s/${data.id}#${key}`;
    $('password-hint').hidden = !password;
    form.reset();
    form.hidden = true;
    $('result').hidden = false;
    $('link').select();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Crear enlace';
  }
});

$('copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('link').value);
  $('copy-link').textContent = '¡Copiado!';
  setTimeout(() => ($('copy-link').textContent = 'Copiar'), 1500);
});

$('new-secret').addEventListener('click', () => {
  $('link').value = '';
  $('result').hidden = true;
  form.hidden = false;
  $('secret').focus();
});
