import { signIn } from '../core/auth.js';
import { loadFeatures } from '../core/features.js';

const API_BASE = import.meta.env.PROD
    ? 'https://nyc-subway-api.fly.dev'
    : 'http://localhost:8080';

const GOOGLE_CLIENT_ID =
    '877965508099-0qp754dcgorvj9eho70olieasha83206.apps.googleusercontent.com';

function field(label, type, name) {
    const div = document.createElement('div');
    div.className = 'auth-field';

    const lbl = document.createElement('label');
    lbl.className = 'auth-label';
    lbl.textContent = label;
    lbl.setAttribute('for', `auth-${name}`);

    const input = document.createElement('input');
    input.className = 'auth-input';
    input.type = type;
    input.id = `auth-${name}`;
    input.name = name;
    input.autocomplete = type === 'password' ? 'current-password' : name;

    const err = document.createElement('div');
    err.className = 'auth-error';

    div.append(lbl, input, err);
    return { div, input, err };
}

function submitBtn(text) {
    const btn = document.createElement('button');
    btn.className = 'auth-submit';
    btn.type = 'submit';
    btn.textContent = text;
    return btn;
}

function linkBtn(text) {
    const btn = document.createElement('button');
    btn.className = 'auth-link';
    btn.type = 'button';
    btn.textContent = text;
    return btn;
}

function divider() {
    const div = document.createElement('div');
    div.className = 'auth-divider';
    const span = document.createElement('span');
    span.textContent = 'or';
    div.append(span);
    return div;
}

export function buildAuthModal(container) {
    const backdrop = document.createElement('div');
    backdrop.id = 'auth-backdrop';

    const card = document.createElement('div');
    card.id = 'auth-card';

    const closeBtn = document.createElement('button');
    closeBtn.id = 'auth-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.innerHTML = '&times;';

    const title = document.createElement('h2');
    title.id = 'auth-title';

    const errorBanner = document.createElement('div');
    errorBanner.className = 'auth-banner auth-error';

    const successBanner = document.createElement('div');
    successBanner.className = 'auth-banner auth-success';

    // --- Sign In screen ---
    const signInScreen = document.createElement('form');
    signInScreen.className = 'auth-screen';

    const siEmail = field('Email', 'email', 'signin-email');
    const siPassword = field('Password', 'password', 'signin-password');
    const siSubmit = submitBtn('Sign in');
    const siGoogleDiv = document.createElement('div');
    siGoogleDiv.className = 'auth-google';
    const siForgotLink = linkBtn('Forgot password?');
    const siCreateLink = linkBtn('Create an account');
    const siLinks = document.createElement('div');
    siLinks.className = 'auth-links';
    siLinks.append(siForgotLink, siCreateLink);

    signInScreen.append(
        siEmail.div, siPassword.div, siSubmit,
        divider(), siGoogleDiv, siLinks,
    );

    // --- Create Account screen ---
    const createScreen = document.createElement('form');
    createScreen.className = 'auth-screen';

    const caName = field('Display name', 'text', 'create-name');
    const caEmail = field('Email', 'email', 'create-email');
    const caPassword = field('Password', 'password', 'create-password');
    caPassword.input.autocomplete = 'new-password';
    const caSubmit = submitBtn('Create account');
    const caGoogleDiv = document.createElement('div');
    caGoogleDiv.className = 'auth-google';
    const caSignInLink = linkBtn('Already have an account? Sign in');
    const caLinks = document.createElement('div');
    caLinks.className = 'auth-links';
    caLinks.append(caSignInLink);

    createScreen.append(
        caName.div, caEmail.div, caPassword.div, caSubmit,
        divider(), caGoogleDiv, caLinks,
    );

    // --- Forgot Password screen ---
    const forgotScreen = document.createElement('form');
    forgotScreen.className = 'auth-screen';

    const fpEmail = field('Email', 'email', 'forgot-email');
    const fpSubmit = submitBtn('Send reset link');
    const fpSignInLink = linkBtn('Back to sign in');
    const fpLinks = document.createElement('div');
    fpLinks.className = 'auth-links';
    fpLinks.append(fpSignInLink);

    forgotScreen.append(fpEmail.div, fpSubmit, fpLinks);

    card.append(closeBtn, title, errorBanner, successBanner,
        signInScreen, createScreen, forgotScreen);
    container.append(backdrop, card);

    const screens = { 'sign-in': signInScreen, 'create-account': createScreen, 'forgot-password': forgotScreen };
    const titles = { 'sign-in': 'Sign in', 'create-account': 'Create account', 'forgot-password': 'Forgot password' };

    function showScreen(name) {
        for (const s of Object.values(screens)) s.hidden = true;
        screens[name].hidden = false;
        title.textContent = titles[name];
        errorBanner.textContent = '';
        successBanner.textContent = '';
        errorBanner.hidden = true;
        successBanner.hidden = true;
    }

    function showError(msg) {
        errorBanner.textContent = msg;
        errorBanner.hidden = false;
        successBanner.hidden = true;
    }

    function showSuccess(msg) {
        successBanner.textContent = msg;
        successBanner.hidden = false;
        errorBanner.hidden = true;
    }

    function setLoading(btn, loading) {
        btn.disabled = loading;
        btn.textContent = loading ? 'Loading…' : btn.dataset.label;
    }

    siSubmit.dataset.label = 'Sign in';
    caSubmit.dataset.label = 'Create account';
    fpSubmit.dataset.label = 'Send reset link';

    // --- Sign In ---
    signInScreen.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = siEmail.input.value.trim();
        const password = siPassword.input.value;
        if (!email || !password) { showError('All fields are required'); return; }
        setLoading(siSubmit, true);
        try {
            const res = await fetch(`${API_BASE}/api/auth/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });
            const data = await res.json();
            if (!res.ok) { showError(data.error || 'Sign in failed'); return; }
            signIn(data.accessToken, data.refreshToken, data.user);
            loadFeatures();
            close();
        } catch { showError('Network error'); }
        finally { setLoading(siSubmit, false); }
    });

    // --- Create Account ---
    createScreen.addEventListener('submit', async (e) => {
        e.preventDefault();
        const displayName = caName.input.value.trim();
        const email = caEmail.input.value.trim();
        const password = caPassword.input.value;
        if (!displayName || !email || !password) { showError('All fields are required'); return; }
        if (password.length < 8) { showError('Password must be at least 8 characters'); return; }
        setLoading(caSubmit, true);
        try {
            const res = await fetch(`${API_BASE}/api/auth/register`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, displayName }),
            });
            const data = await res.json();
            if (!res.ok) { showError(data.error || 'Registration failed'); return; }
            showSuccess(data.message || 'Check your email to verify your account');
        } catch { showError('Network error'); }
        finally { setLoading(caSubmit, false); }
    });

    // --- Forgot Password ---
    forgotScreen.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = fpEmail.input.value.trim();
        if (!email) { showError('Email is required'); return; }
        setLoading(fpSubmit, true);
        try {
            const res = await fetch(`${API_BASE}/api/auth/forgot-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email }),
            });
            const data = await res.json();
            if (!res.ok) { showError(data.error || 'Could not send the reset link'); return; }
            showSuccess(data.message || 'If that email is registered, a reset link has been sent');
        } catch { showError('Network error'); }
        finally { setLoading(fpSubmit, false); }
    });

    // --- Navigation ---
    siForgotLink.addEventListener('click', () => showScreen('forgot-password'));
    siCreateLink.addEventListener('click', () => showScreen('create-account'));
    caSignInLink.addEventListener('click', () => showScreen('sign-in'));
    fpSignInLink.addEventListener('click', () => showScreen('sign-in'));

    // --- Google ---
    let googleReady = false;
    function initGoogle() {
        if (googleReady || !window.google?.accounts) return;
        googleReady = true;

        google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: handleGoogleResponse,
        });

        const opts = { theme: 'filled_black', size: 'large', width: 320 };
        google.accounts.id.renderButton(siGoogleDiv, opts);
        google.accounts.id.renderButton(caGoogleDiv, opts);
    }

    async function handleGoogleResponse(response) {
        try {
            const res = await fetch(`${API_BASE}/api/auth/google`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken: response.credential }),
            });
            const data = await res.json();
            if (!res.ok) { showError(data.error || 'Google sign-in failed'); return; }
            signIn(data.accessToken, data.refreshToken, data.user);
            loadFeatures();
            close();
        } catch { showError('Google sign-in failed'); }
    }

    // --- Open / Close ---
    function open() {
        container.classList.remove('hidden');
        showScreen('sign-in');
        initGoogle();
        siEmail.input.focus();
    }

    function close() {
        container.classList.add('hidden');
    }

    backdrop.addEventListener('click', close);
    closeBtn.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !container.classList.contains('hidden')) {
            close();
        }
    });

    return { open, close };
}
