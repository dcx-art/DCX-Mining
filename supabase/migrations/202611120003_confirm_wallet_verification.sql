CREATE OR REPLACE FUNCTION public.confirm_wallet_verification(
  p_payment_id bigint,
  p_transaction_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment public.wallet_verification_payments%ROWTYPE;
  v_user public."User"%ROWTYPE;
BEGIN
  IF p_transaction_hash IS NULL OR length(trim(p_transaction_hash)) < 20 THEN
    RETURN jsonb_build_object('success', false, 'error', 'Hash transaksi tidak valid');
  END IF;

  SELECT * INTO v_payment
  FROM public.wallet_verification_payments
  WHERE id = p_payment_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'Pembayaran tidak ditemukan');
  END IF;

  IF v_payment.status = 'verified' THEN
    IF v_payment.transaction_hash = p_transaction_hash THEN
      RETURN jsonb_build_object('success', true, 'already_verified', true);
    END IF;
    RETURN jsonb_build_object('success', false, 'error', 'Pembayaran sudah memakai transaksi lain');
  END IF;

  IF v_payment.status <> 'pending' OR v_payment.expires_at < now() THEN
    RETURN jsonb_build_object('success', false, 'error', 'Permintaan pembayaran kedaluwarsa');
  END IF;

  SELECT * INTO v_user
  FROM public."User"
  WHERE telegram_id = v_payment.telegram_id
  FOR UPDATE;

  IF NOT FOUND OR v_user.wallet_address IS NULL
     OR lower(v_user.wallet_address) <> lower(v_payment.wallet_address) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Wallet pengguna tidak cocok');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.wallet_verification_payments
    WHERE transaction_hash = p_transaction_hash AND id <> p_payment_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error', 'Transaksi ini sudah digunakan');
  END IF;

  UPDATE public.wallet_verification_payments
  SET status = 'verified',
      transaction_hash = p_transaction_hash,
      verified_at = now()
  WHERE id = p_payment_id;

  UPDATE public."User"
  SET wallet_verified = true,
      wallet_verified_at = now(),
      wallet_verification_tx_hash = p_transaction_hash
  WHERE telegram_id = v_payment.telegram_id;

  RETURN jsonb_build_object('success', true, 'already_verified', false);
END;
$$;

REVOKE ALL ON FUNCTION public.confirm_wallet_verification(bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_wallet_verification(bigint, text) TO service_role;
