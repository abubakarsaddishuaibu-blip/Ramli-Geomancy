// Central configuration. Secrets are read from environment variables only and are
// never sent to the browser.
export const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || '',
  supabaseUrl: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  paystackSecretKey: process.env.PAYSTACK_SECRET_KEY || '',
  paystackBaseUrl: process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
  // One-time registration fee in kobo (Naira minor units). N15,000 = 1,500,000 kobo.
  registrationFeeKobo: Number(process.env.REGISTRATION_FEE_KOBO || 1500000),
  registrationFeeCurrency: process.env.REGISTRATION_FEE_CURRENCY || 'NGN',
  appBaseUrl: (process.env.APP_BASE_URL || '').replace(/\/+$/, ''),
  sessionTtlSeconds: Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 12)
};

export function missingConfig() {
  const missing = [];
  if (!config.supabaseUrl) missing.push('SUPABASE_URL');
  if (!config.supabaseServiceKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!config.supabaseAnonKey) missing.push('SUPABASE_ANON_KEY');
  if (!config.paystackSecretKey) missing.push('PAYSTACK_SECRET_KEY');
  if (!config.sessionSecret) missing.push('SESSION_SECRET');
  return missing;
}

export function supabaseConfigured() {
  return Boolean(config.supabaseUrl && config.supabaseServiceKey && config.supabaseAnonKey);
}

export function paystackConfigured() {
  return Boolean(config.paystackSecretKey);
}
