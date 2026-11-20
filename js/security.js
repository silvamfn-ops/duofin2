import { $, showToast } from './config.js';

const SEC_KEY = 'duofin2-security-v1';
const secDefaults = { pinHash: '', pinSalt: '', autoLockMin: 5, bioCredId: '', privacyMask: false };

export class SecurityManager {
  constructor() {
    try {
      this.cfg = { ...secDefaults, ...JSON.parse(localStorage.getItem(SEC_KEY) || '{}') };
    } catch {
      this.cfg = { ...secDefaults };
    }
    this.locked = false;
    this.lastActivity = Date.now();
  }

  save() {
    localStorage.setItem(SEC_KEY, JSON.stringify(this.cfg));
  }

  hasPin() {
    return !!(this.cfg.pinHash && this.cfg.pinSalt);
  }

  bufToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  b64ToBuf(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  randomBytes(len) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return arr;
  }

  async hashPin(pin, saltB64) {
    const data = new TextEncoder().encode(`${saltB64}:${pin}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return this.bufToB64(digest);
  }

  async setPin(pin, autoLockMin = 5) {
    const salt = this.bufToB64(this.randomBytes(16));
    const hash = await this.hashPin(pin, salt);
    this.cfg.pinSalt = salt;
    this.cfg.pinHash = hash;
    this.cfg.autoLockMin = Number(autoLockMin);
    this.save();
  }

  disablePin() {
    this.cfg.pinHash = '';
    this.cfg.pinSalt = '';
    this.cfg.bioCredId = '';
    this.save();
  }

  async verifyPin(pin) {
    if (!this.hasPin()) return true;
    const h = await this.hashPin(pin, this.cfg.pinSalt);
    if (h === this.cfg.pinHash) {
      this.unlock();
      return true;
    }
    return false;
  }

  lock() {
    if (!this.hasPin()) return;
    this.locked = true;
    const ov = $('appLockOverlay');
    if (ov) ov.hidden = false;
    if ($('appLockPinInput')) {
      $('appLockPinInput').value = '';
      $('appLockPinInput').focus();
    }
    if ($('appLockBioBtn')) $('appLockBioBtn').hidden = !this.cfg.bioCredId;
  }

  unlock() {
    this.locked = false;
    this.lastActivity = Date.now();
    const ov = $('appLockOverlay');
    if (ov) ov.hidden = true;
  }

  togglePrivacy() {
    this.cfg.privacyMask = !this.cfg.privacyMask;
    this.save();
    this.applyPrivacy();
    showToast(this.cfg.privacyMask ? 'Modo privacidade ativado (valores ocultos).' : 'Valores monetários visíveis.');
  }

  applyPrivacy() {
    document.body.classList.toggle('privacy-masked', !!this.cfg.privacyMask);
    const btn = $('privacyToggleBtn');
    if (btn) btn.classList.toggle('is-active', !!this.cfg.privacyMask);
  }

  async enableBiometrics() {
    if (!window.PublicKeyCredential || !navigator.credentials) {
      throw new Error('Este dispositivo não suporta autenticação biométrica WebAuthn.');
    }
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: this.randomBytes(32),
        rp: { name: 'DuoFin 2' },
        user: { id: this.randomBytes(16), name: 'duofin2-user', displayName: 'Utilizador DuoFin 2' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000
      }
    });
    if (cred && cred.rawId) {
      this.cfg.bioCredId = this.bufToB64(cred.rawId);
      this.save();
    }
  }

  async unlockWithBiometrics() {
    if (!this.cfg.bioCredId || !navigator.credentials) return false;
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: this.randomBytes(32),
        allowCredentials: [{ id: this.b64ToBuf(this.cfg.bioCredId), type: 'public-key' }],
        userVerification: 'required',
        timeout: 60000
      }
    });
    if (assertion) {
      this.unlock();
      return true;
    }
    return false;
  }

  startIdleWatcher() {
    ['pointerdown', 'keydown', 'touchstart', 'scroll'].forEach(ev => {
      document.addEventListener(ev, () => {
        if (!this.locked) this.lastActivity = Date.now();
      }, { passive: true });
    });

    setInterval(() => {
      if (!this.hasPin() || this.locked) return;
      const mins = Number(this.cfg.autoLockMin || 0);
      if (mins > 0 && Date.now() - this.lastActivity >= mins * 60000) {
        this.lock();
      }
    }, 10000);
  }
}
