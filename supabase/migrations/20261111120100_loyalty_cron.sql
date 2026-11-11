-- Domma Food · 014b · Expira cashback vencido todo dia às 03:30 (Brasília)
select cron.schedule('domma-loyalty-expire', '30 6 * * *', $$select private.loyalty_expire()$$);
