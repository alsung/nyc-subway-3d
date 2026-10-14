import { getUser, onAuthChange, signOut } from '../core/auth.js';
import { loadFeatures } from '../core/features.js';

export function buildAuthButton(container, onSignInClick) {
    const wrapper = document.createElement('div');
    wrapper.id = 'auth-wrapper';

    const btn = document.createElement('button');
    btn.id = 'auth-btn';
    btn.type = 'button';

    const dropdown = document.createElement('div');
    dropdown.id = 'auth-dropdown';
    dropdown.classList.add('hidden');

    const ddEmail = document.createElement('div');
    ddEmail.className = 'auth-dropdown-email';

    const ddTier = document.createElement('div');
    ddTier.className = 'auth-dropdown-tier';

    const ddDivider = document.createElement('hr');
    ddDivider.className = 'auth-dropdown-divider';

    const ddSignout = document.createElement('button');
    ddSignout.className = 'auth-dropdown-signout';
    ddSignout.type = 'button';
    ddSignout.textContent = 'Sign out';

    dropdown.append(ddEmail, ddTier, ddDivider, ddSignout);
    wrapper.append(btn, dropdown);

    const dot = document.createElement('span');
    dot.setAttribute('aria-hidden', 'true');
    dot.textContent = '·';
    container.append(dot, wrapper);

    function render(user) {
        if (user) {
            const initials = user.displayName
                .split(/\s+/)
                .slice(0, 2)
                .map(w => w[0]?.toUpperCase() ?? '')
                .join('');
            btn.innerHTML = '';
            const avatar = document.createElement('span');
            avatar.className = 'auth-avatar';
            avatar.textContent = initials;
            const name = document.createElement('span');
            name.textContent = user.displayName;
            btn.append(avatar, name);
            btn.classList.add('signed-in');

            ddEmail.textContent = user.email;
            ddTier.textContent = user.tier === 'pro' ? 'Pro' : 'Free';
        } else {
            btn.textContent = 'Sign in';
            btn.classList.remove('signed-in');
            dropdown.classList.add('hidden');
        }
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (getUser()) {
            dropdown.classList.toggle('hidden');
        } else {
            onSignInClick();
        }
    });

    ddSignout.addEventListener('click', () => {
        signOut();
        loadFeatures();
        dropdown.classList.add('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !dropdown.classList.contains('hidden')) {
            dropdown.classList.add('hidden');
        }
    });

    onAuthChange(render);
    render(getUser());
}
