const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
};

export const config = {
  port: Number(process.env.PORT || 3001),
  databaseUrl: required('DATABASE_URL'),
  apiKey: required('SHOPIFY_API_KEY'),
  apiSecret: required('SHOPIFY_API_SECRET'),
  apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
  scopes: (process.env.SHOPIFY_SCOPES || 'read_products,write_products')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // Public https origin of the deployed app, e.g. https://my-app.beachhead.example
  appUrl: required('APP_URL').replace(/\/+$/, ''),
  schedulerEnabled: process.env.SCHEDULER_ENABLED !== 'false',
};

export const scopeString = config.scopes.join(',');
