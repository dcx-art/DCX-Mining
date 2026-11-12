ALTER TABLE public.wallet_verification_payments
  ADD COLUMN IF NOT EXISTS payment_reference text,
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS wallet_verification_payment_reference_unique
  ON public.wallet_verification_payments (payment_reference)
  WHERE payment_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS wallet_verification_pending_expiry_idx
  ON public.wallet_verification_payments (expires_at)
  WHERE status = 'pending';
