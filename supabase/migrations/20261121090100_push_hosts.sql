-- Domma Food · 048b · Web Push: o Chromium (e navegadores baseados nele sem as chaves do Google) assina em jmt17.google.com
alter table public.push_subscriptions drop constraint push_subscriptions_endpoint_check;
alter table public.push_subscriptions add constraint push_subscriptions_endpoint_check check (char_length(endpoint) <= 1000 and endpoint ~ ('^https://(' ||
  'fcm\.googleapis\.com|android\.googleapis\.com|jmt17\.google\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|' ||
  '[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.apple\.com|[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com)/'));
