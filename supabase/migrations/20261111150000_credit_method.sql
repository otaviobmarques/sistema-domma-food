-- Domma Food · 017 · forma de pagamento "fiado" (conta do cliente)
alter type public.payment_method add value if not exists 'credit_account';
