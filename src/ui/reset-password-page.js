const API_BASE = import.meta.env.PROD
    ? 'https://nyc-subway-api.fly.dev'
    : 'http://localhost:8080';

export async function renderResetPasswordPage() {
    const token = new URLSearchParams(window.location.search).get('token');

    document.getElementById('ui').hidden = true;
    document.getElementById('map').hidden = true;
    document.getElementById('app-footer').hidden = true;

    const page = document.createElement('div');
    page.className = 'auth-page';
    const card = document.createElement('div');
    card.className = 'auth-page-card';
    page.appendChild(card);
    document.body.appendChild(page);

    if (!token) {
        card.innerHTML =
            '<h2>Invalid link</h2>' +
            '<p>This reset link is missing a token.</p>' +
            '<a href="/" class="auth-page-link">Go to Local Express</a>';
        return;
    }

    const form = document.createElement('form');
    form.innerHTML =
        '<h2>Reset password</h2>' +
        '<div class="auth-field">' +
            '<label class="auth-label" for="reset-pw">New password</label>' +
            '<input class="auth-input" type="password" id="reset-pw" autocomplete="new-password" />' +
        '</div>' +
        '<div class="auth-field">' +
            '<label class="auth-label" for="reset-pw-confirm">Confirm password</label>' +
            '<input class="auth-input" type="password" id="reset-pw-confirm" autocomplete="new-password" />' +
        '</div>' +
        '<div class="auth-error auth-page-error"></div>' +
        '<button class="auth-submit" type="submit">Reset password</button>';

    card.appendChild(form);

    const errorEl = form.querySelector('.auth-page-error');
    const submitBtn = form.querySelector('.auth-submit');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = form.querySelector('#reset-pw').value;
        const confirm = form.querySelector('#reset-pw-confirm').value;
        errorEl.textContent = '';

        if (password.length < 8) {
            errorEl.textContent = 'Password must be at least 8 characters';
            return;
        }
        if (password !== confirm) {
            errorEl.textContent = 'Passwords do not match';
            return;
        }

        submitBtn.disabled = true;
        submitBtn.textContent = 'Resetting…';

        try {
            const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, newPassword: password }),
            });

            if (res.ok) {
                card.innerHTML =
                    '<h2>Password updated</h2>' +
                    '<p>You can now sign in with your new password.</p>' +
                    '<a href="/" class="auth-page-link">Go to Local Express</a>';
            } else {
                const data = await res.json().catch(() => ({}));
                errorEl.textContent = data.error || 'This link is invalid or has expired.';
                submitBtn.disabled = false;
                submitBtn.textContent = 'Reset password';
            }
        } catch {
            errorEl.textContent = 'Could not reach the server. Please try again later.';
            submitBtn.disabled = false;
            submitBtn.textContent = 'Reset password';
        }
    });
}
