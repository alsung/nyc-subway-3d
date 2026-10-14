const API_BASE = import.meta.env.PROD
    ? 'https://nyc-subway-api.fly.dev'
    : 'http://localhost:8080';

export async function renderVerifyPage() {
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
            '<p>This verification link is missing a token.</p>' +
            '<a href="/" class="auth-page-link">Go to Local Express</a>';
        return;
    }

    card.innerHTML = '<p class="auth-page-loading">Verifying your email…</p>';

    try {
        const res = await fetch(`${API_BASE}/api/auth/verify-email`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token }),
        });

        if (res.ok) {
            card.innerHTML =
                '<h2>Email verified</h2>' +
                '<p>Your account is ready. You can now sign in.</p>' +
                '<a href="/" class="auth-page-link">Go to Local Express</a>';
        } else {
            const data = await res.json().catch(() => ({}));
            card.innerHTML =
                '<h2>Verification failed</h2>' +
                `<p>${data.error || 'This link is invalid or has expired.'}</p>` +
                '<a href="/" class="auth-page-link">Go to Local Express</a>';
        }
    } catch {
        card.innerHTML =
            '<h2>Something went wrong</h2>' +
            '<p>Could not reach the server. Please try again later.</p>' +
            '<a href="/" class="auth-page-link">Go to Local Express</a>';
    }
}
