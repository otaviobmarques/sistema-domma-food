-- Domma Food · 013a · Novas formas de pagamento do PDV (em migração própria: valores de enum só podem ser usados depois do commit)
alter type public.payment_method add value if not exists 'credit_card';
alter type public.payment_method add value if not exists 'debit_card';
