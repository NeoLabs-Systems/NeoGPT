'use strict';

const alertEl      = document.getElementById('alert');
const loginForm    = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');

function showAlert(msg, type = 'error') {
  alertEl.textContent = msg;
  alertEl.className   = `alert ${type}`;
}

function hideAlert() {
  alertEl.className = 'alert';
}

// ── Tab switching ──────────────────────────────────────────────────────────────
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.form-section').forEach(s => s.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(`${btn.dataset.tab}-section`).classList.add('active');
    hideAlert();
  });
});

// ── Login ─────────────────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  hideAlert();

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('login-username').value,
        password: document.getElementById('login-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    window.location.href = '/app';
  } catch (err) {
    showAlert(err.message);
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

// ── Register ──────────────────────────────────────────────────────────────────
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('reg-btn');
  btn.disabled = true;
  btn.textContent = 'Creating…';
  hideAlert();

  try {
    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.getElementById('reg-username').value,
        email:    document.getElementById('reg-email').value,
        password: document.getElementById('reg-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    window.location.href = '/app';
  } catch (err) {
    showAlert(err.message);
    btn.disabled = false;
    btn.textContent = 'Create Account';
  }
});
