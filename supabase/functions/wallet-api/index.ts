import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { Address, beginCell, Cell } from "npm:@ton/core@0.59.0";
import { Buffer } from "node:buffer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TONCENTER_API_KEY = Deno.env.get("TONCENTER_API_KEY") || "";
const WALLET_SYNC_SECRET = Deno.env.get("WALLET_SYNC_SECRET") || "";

const TABLE = "User";
const TON_API = "https://toncenter.com/api/v3";
const TON_NETWORK = "-239";
const TOKEN_MASTER = "EQBngyvuH7wWCW_sYUyC0iyb7uPFvkG2eiR0BscnMqa_k6AS";
const VERIFY_RECEIVER = "UQDZJan6ICt2fXxKzPxjGFA-ztTb6mvLtmbEnwoeGn5UH_JN";
const VERIFY_NANO_TON = 90000000n;
const NANO = 1000000000n;
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-wallet-sync-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function toHex(buffer: ArrayBuffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function verifyTelegram(initData: string): Promise<string> {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) throw new Error("Telegram hash tidak ditemukan");
  params.delete("hash");

  const entries = Array.from(params.entries()).sort(([a], [b]) => a.localeCompare(b));
  const dataCheckString = entries.map(([key, value]) => `${key}=${value}`).join("\n");
  const encoder = new TextEncoder();

  const secretKey = await crypto.subtle.importKey(
    "raw", encoder.encode("WebAppData"),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const secret = await crypto.subtle.sign("HMAC", secretKey, encoder.encode(BOT_TOKEN));
  const validationKey = await crypto.subtle.importKey(
    "raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const calculatedHash = toHex(await crypto.subtle.sign(
    "HMAC", validationKey, encoder.encode(dataCheckString),
  ));
  if (calculatedHash !== hash) throw new Error("Autentikasi Telegram tidak valid");

  const authDate = Number(params.get("auth_date"));
  if (!authDate || Date.now() / 1000 - authDate > 86400 || authDate > Date.now() / 1000 + 60) {
    throw new Error("Sesi Telegram sudah kedaluwarsa");
  }
  const userData = params.get("user");
  if (!userData) throw new Error("Data pengguna Telegram tidak ditemukan");
  const user = JSON.parse(userData);
  if (!user.id) throw new Error("Telegram ID tidak valid");
  return String(user.id);
}

function rawAddress(value: string): string {
  const normalized = value.trim();
  try {
    return Address.parse(normalized).toRawString();
  } catch {
    return Address.parseFriendly(normalized).address.toRawString();
  }
}

function decimalToNano(value: string | number): bigint {
  const [whole, fraction = ""] = String(value).split(".");
  return BigInt(whole || "0") * NANO +
    BigInt((fraction + "000000000").slice(0, 9));
}

function rawToDecimal(value: string): string {
  const amount = BigInt(value || "0");
  const whole = amount / NANO;
  const fraction = (amount % NANO).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function getUser(telegramId: string) {
  const { data, error } = await supabase.from(TABLE).select("*")
    .eq("telegram_id", telegramId).maybeSingle();
  if (error) throw new Error("Gagal membaca pengguna: " + error.message);
  if (!data) throw new Error("Pengguna belum terdaftar di database");
  return data;
}

async function tonFetch(path: string) {
  const headers: Record<string, string> = {};
  if (TONCENTER_API_KEY) headers["X-API-Key"] = TONCENTER_API_KEY;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const response = await fetch(`${TON_API}${path}`, { headers, signal: controller.signal });
      const body = await response.text();
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, 300));
          continue;
        }
        throw new Error(`TON Center gagal (${response.status}). Coba periksa kembali.`);
      }
      let data: any;
      try { data = JSON.parse(body); } catch { throw new Error("Respons TON Center tidak valid"); }
      if (data?.error) throw new Error("TON Center: " + String(data.error));
      return data;
    } catch (error) {
      lastError = error;
      if (attempt >= 2) break;
      await new Promise(resolve => setTimeout(resolve, 300));
    } finally {
      clearTimeout(timeout);
    }
  }
  if (lastError instanceof Error && lastError.name === "AbortError") {
    throw new Error("TON Center terlalu lama merespons. Pengecekan akan dicoba kembali.");
  }
  throw new Error(lastError instanceof Error ? lastError.message : "TON Center tidak dapat dihubungi.");
}

async function readDcxBalance(walletAddress: string): Promise<{ raw: string; decimal: string }> {
  const query = new URLSearchParams({
    owner_address: walletAddress,
    jetton_address: TOKEN_MASTER,
    limit: "10",
  });
  const data = await tonFetch(`/jetton/wallets?${query.toString()}`);
  const expectedOwner = rawAddress(walletAddress);
  const expectedMaster = rawAddress(TOKEN_MASTER);
  const wallets = Array.isArray(data.jetton_wallets) ? data.jetton_wallets : [];
  const matching = wallets.find((item: any) =>
    rawAddress(item.owner) === expectedOwner &&
    rawAddress(item.jetton) === expectedMaster
  );
  const raw = matching?.balance ? String(matching.balance) : "0";
  return { raw, decimal: rawToDecimal(raw) };
}

async function calculateLevel(balanceRaw: string) {
  const { data, error } = await supabase.from("dcx_level_rules")
    .select("level, holding_required_dcx")
    .order("level", { ascending: false });
  if (error || !data) throw new Error("Gagal membaca aturan level DCX");
  const balance = BigInt(balanceRaw);
  for (const rule of data) {
    if (balance >= decimalToNano(rule.holding_required_dcx)) return Number(rule.level);
  }
  return 1;
}

async function refreshUserBalance(user: any) {
  if (!user.wallet_verified || !user.wallet_address) {
    throw new Error("Wallet belum terverifikasi");
  }
  const balance = await readDcxBalance(user.wallet_address);
  const level = await calculateLevel(balance.raw);
  const { data, error } = await supabase.from(TABLE).update({
    wallet_balance_dcx: balance.decimal,
    wallet_balance_checked_at: new Date().toISOString(),
    level,
  }).eq("telegram_id", user.telegram_id)
    .select("wallet_balance_dcx, wallet_balance_checked_at, level, wallet_verified, wallet_address")
    .single();
  if (error) throw new Error("Gagal menyimpan saldo wallet: " + error.message);
  return data;
}

function readVerificationComment(body: string | undefined): string | null {
  if (!body) return null;
  try {
    const cell = Cell.fromBoc(Buffer.from(body, "base64"))[0];
    const slice = cell.beginParse();
    if (slice.remainingBits < 32 || slice.loadUint(32) !== 0) return null;
    return slice.loadStringTail();
  } catch {
    return null;
  }
}

function tryRawAddress(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return rawAddress(value.trim()); } catch { return null; }
}

async function findPaymentTransaction(payment: any) {
  const createdAt = new Date(payment.created_at).getTime();
  const expiresAt = new Date(payment.expires_at).getTime();
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) {
    throw new Error("Waktu permintaan pembayaran tidak valid");
  }

  // Normalize friendly (UQ/EQ) and raw (workchain:hash) addresses before querying TON Center.
  const expectedSource = tryRawAddress(payment.wallet_address);
  const expectedDestination = tryRawAddress(VERIFY_RECEIVER);
  if (!expectedSource || !expectedDestination) {
    throw new Error("Alamat wallet verifikasi tidak valid");
  }

  // Restrict the lookup to the payment's validity window.
  const query = new URLSearchParams({
    account: expectedSource,
    start_utime: String(Math.max(0, Math.floor(createdAt / 1000) - 60)),
    end_utime: String(Math.floor(expiresAt / 1000)),
    limit: "1000",
    sort: "desc",
  });
  const data = await tonFetch(`/transactions?${query.toString()}`);
  const transactions = Array.isArray(data.transactions) ? data.transactions : [];
  if (!expectedSource || !expectedDestination) {
    throw new Error("Alamat wallet verifikasi tidak valid");
  }
  const expectedComment = `DCX-VERIFY:${payment.payment_reference}`;

  for (const tx of transactions) {
    const description = tx?.description;
    if (!tx?.hash) continue;
    if (description?.aborted === true) continue;
    if (description?.compute_ph?.success !== true) continue;
    if (description?.action?.success !== true) continue;
    if (Number(tx.mc_block_seqno || 0) <= 0) continue;

    const txTime = Number(tx.now || 0) * 1000;
        if (!Number.isFinite(txTime) || txTime < createdAt) continue;
    // A payment made before the request expiry remains eligible for settlement,
    // even if the user retries verification after that expiry.
    if (Number.isFinite(expiresAt) && txTime > expiresAt) continue;

    const outbound = Array.isArray(tx.out_msgs) ? tx.out_msgs : [];
    for (const msg of outbound) {
      if (!msg || msg.bounced === true) continue;
      const source = tryRawAddress(msg.source);
      const destination = tryRawAddress(msg.destination);
      if (source !== expectedSource || destination !== expectedDestination) continue;

      let value: bigint;
      try { value = BigInt(String(msg.value || "0")); } catch { continue; }
      const expectedAmount = BigInt(String(payment.amount_nano_ton || VERIFY_NANO_TON));
      if (value !== expectedAmount) continue;
      if (readVerificationComment(msg.message_content?.body) !== expectedComment) continue;

      return String(tx.hash);
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ success: false, error: "Method tidak diizinkan" }, 405);

  try {
    const body = await req.json();
    const action = String(body.action || "");

    if (action === "sync_all") {
      const suppliedSecret = req.headers.get("x-wallet-sync-secret") || "";
      const { data: syncAuthorized, error: syncAuthError } = await supabase.rpc(
        "verify_dcx_wallet_sync_secret",
        { p_candidate: suppliedSecret },
      );
      if (syncAuthError || syncAuthorized !== true) {
        return json({ success: false, error: "Akses sinkronisasi ditolak" }, 401);
      }
      const { data: users, error } = await supabase.from(TABLE)
        .select("telegram_id, wallet_address, wallet_verified")
        .eq("wallet_verified", true);
      if (error) throw error;
      let updated = 0;
      for (const user of users || []) {
        try {
          await refreshUserBalance(user);
          updated++;
        } catch (error) {
          console.error("Wallet sync failed for user", user.telegram_id, error);
        }
      }
      return json({ success: true, updated, checked: (users || []).length });
    }

    const telegramId = await verifyTelegram(String(body.initData || ""));
    const user = await getUser(telegramId);

    if (action === "level_rules") {
      const { data: rules, error } = await supabase.from("dcx_level_rules")
        .select("level, holding_required_dcx, base_reward_dcx_per_day, bonus_reward_dcx_per_day")
        .order("level", { ascending: true });
      if (error) throw new Error("Gagal membaca daftar level DCX: " + error.message);
      return json({ success: true, rules: rules || [] });
    }

    if (action === "status") {
      return json({
        success: true,
        wallet_address: user.wallet_address,
        wallet_verified: Boolean(user.wallet_verified),
        wallet_balance_dcx: String(user.wallet_balance_dcx || "0"),
        wallet_balance_checked_at: user.wallet_balance_checked_at,
        level: Number(user.level || 1),
        verification_fee_ton: "0.09",
        verification_receiver: VERIFY_RECEIVER,
        network: "TON mainnet",
      });
    }

    if (action === "pending_verification") {
      if (!user.wallet_address) return json({ success: true, pending: false });
      const { data: payment, error } = await supabase.from("wallet_verification_payments")
        .select("id, expires_at, payment_reference")
        .eq("telegram_id", telegramId)
        .eq("wallet_address", user.wallet_address)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return json(payment
        ? { success: true, pending: true, payment_id: payment.id, expires_at: payment.expires_at }
        : { success: true, pending: false });
    }

    if (action === "connect_wallet") {
      const address = String(body.walletAddress || "").trim();
      if (!address) throw new Error("Alamat wallet tidak boleh kosong");
      const normalized = rawAddress(address).toLowerCase();
      const existing = user.wallet_address ? rawAddress(user.wallet_address).toLowerCase() : null;

      const [walletLockResult, accountLockResult] = await Promise.all([
        supabase.from("dcx_wallet_identity_locks")
          .select("wallet_address, telegram_id, verified_at, transaction_hash")
          .eq("wallet_address", normalized).maybeSingle(),
        supabase.from("dcx_wallet_identity_locks")
          .select("wallet_address, telegram_id, verified_at, transaction_hash")
          .eq("telegram_id", telegramId).maybeSingle(),
      ]);
      if (walletLockResult.error) throw walletLockResult.error;
      if (accountLockResult.error) throw accountLockResult.error;

      const walletLock = walletLockResult.data;
      const accountLock = accountLockResult.data;

      if (walletLock && String(walletLock.telegram_id) !== telegramId) {
        throw new Error("Wallet ini sudah terkunci permanen pada akun Telegram lain.");
      }
      if (accountLock && accountLock.wallet_address !== normalized) {
        throw new Error("Akun Telegram ini sudah memiliki wallet verified yang terkunci. Hubungi dukungan DCX untuk perubahan kepemilikan.");
      }
      if (user.wallet_verified === true && existing !== normalized) {
        throw new Error("Wallet akun ini sudah verified dan tidak dapat diganti melalui aplikasi.");
      }

      const previouslyVerified = Boolean(
        walletLock && accountLock &&
        String(walletLock.telegram_id) === telegramId &&
        String(accountLock.telegram_id) === telegramId &&
        walletLock.wallet_address === normalized &&
        accountLock.wallet_address === normalized
      );

      if (existing === normalized && user.wallet_verified === true && previouslyVerified) {
        return json({
          success: true,
          wallet_address: user.wallet_address,
          wallet_verified: true,
        });
      }

      if (existing === normalized && !previouslyVerified) {
        return json({
          success: true,
          wallet_address: user.wallet_address,
          wallet_verified: Boolean(user.wallet_verified),
        });
      }

      const updateValues = previouslyVerified
        ? {
            wallet_address: normalized,
            wallet_verified: true,
            wallet_verified_at: walletLock.verified_at,
            wallet_balance_dcx: 0,
            wallet_balance_checked_at: null,
            level: 1,
            wallet_verification_tx_hash: walletLock.transaction_hash,
          }
        : {
            wallet_address: normalized,
            wallet_verified: false,
            wallet_verified_at: null,
            wallet_balance_dcx: 0,
            wallet_balance_checked_at: null,
            level: 1,
            wallet_verification_tx_hash: null,
          };

      const { data, error } = await supabase.from(TABLE).update(updateValues)
        .eq("telegram_id", telegramId)
        .select("wallet_address, wallet_verified, level")
        .single();
      if (error) {
        if (error.code === "23505") {
          throw new Error("Wallet ini sudah terhubung atau terkunci pada akun DCX lain.");
        }
        throw error;
      }
      return json({ success: true, ...data });
    }

    if (action === "begin_verification") {
      if (!user.wallet_address) throw new Error("Hubungkan wallet TON terlebih dahulu");
      const now = new Date().toISOString();
      const { data: existing, error: existingError } = await supabase
        .from("wallet_verification_payments")
        .select("id, payment_reference, expires_at, amount_nano_ton")
        .eq("telegram_id", telegramId)
        .eq("wallet_address", user.wallet_address)
        .eq("status", "pending")
        .gt("expires_at", now)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existingError) throw existingError;

      let payment = existing;
      if (!payment) {
        const reference = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 20 * 60 * 1000).toISOString();
        const { data, error } = await supabase.from("wallet_verification_payments").insert({
          telegram_id: telegramId,
          wallet_address: user.wallet_address,
          receiver_address: VERIFY_RECEIVER,
          amount_nano_ton: Number(VERIFY_NANO_TON),
          payment_reference: reference,
          expires_at: expiresAt,
          status: "pending",
        }).select("id, payment_reference, expires_at, amount_nano_ton").single();
        if (error) throw error;
        payment = data;
      }

      const comment = `DCX-VERIFY:${payment.payment_reference}`;
      const payload = beginCell()
        .storeUint(0, 32)
        .storeStringTail(comment)
        .endCell()
        .toBoc()
        .toString("base64");

      // Internal round-trip test: ensure the generated TON comment payload
      // can be decoded by the exact parser used for incoming transactions.
      const decodedComment = readVerificationComment(payload);
      if (decodedComment !== comment) {
        throw new Error("Uji internal payload TON gagal. Tidak ada pembayaran yang dikirim.");
      }
      console.info("TON payload round-trip self-test passed", { paymentId: payment.id });

      return json({
        success: true,
        payment_id: payment.id,
        payment_reference: payment.payment_reference,
        comment,
        payload,
        expires_at: payment.expires_at,
        receiver_address: VERIFY_RECEIVER,
        amount_nano_ton: String(payment.amount_nano_ton || VERIFY_NANO_TON),
        network: TON_NETWORK,
      });
    }

    if (action === "verify_payment") {
      const paymentId = Number(body.paymentId);
      if (!Number.isSafeInteger(paymentId) || paymentId <= 0) throw new Error("ID pembayaran tidak valid");
      const { data: payment, error } = await supabase.from("wallet_verification_payments")
        .select("*").eq("id", paymentId).eq("telegram_id", telegramId).maybeSingle();
      if (error || !payment) throw new Error("Permintaan verifikasi tidak ditemukan");
      const paymentWallet = rawAddress(payment.wallet_address).toLowerCase();
      const currentWallet = user.wallet_address
        ? rawAddress(user.wallet_address).toLowerCase()
        : null;

      if (user.wallet_verified === true && currentWallet === paymentWallet) {
        return json({ success: true, wallet_verified: true, message: "Wallet sudah terverifikasi" });
      }

      if (payment.status === "verified") {
        if (currentWallet === paymentWallet) {
          const { data: walletLock, error: walletLockError } = await supabase
            .from("dcx_wallet_identity_locks")
            .select("wallet_address, telegram_id, verified_at, transaction_hash")
            .eq("wallet_address", paymentWallet)
            .maybeSingle();
          if (walletLockError) throw walletLockError;
          if (walletLock && String(walletLock.telegram_id) === telegramId) {
            const { error: restoreError } = await supabase.from(TABLE).update({
              wallet_verified: true,
              wallet_verified_at: walletLock.verified_at,
              wallet_verification_tx_hash: walletLock.transaction_hash,
            }).eq("telegram_id", telegramId);
            if (restoreError) throw restoreError;
            const latest = await getUser(telegramId);
            const wallet = await refreshUserBalance(latest);
            return json({
              success: true,
              wallet_verified: true,
              wallet,
              message: "Wallet verified milik akun ini berhasil dipulihkan.",
            });
          }
        }
        throw new Error("Pembayaran ini sudah selesai dan tidak dapat digunakan ulang oleh akun atau wallet lain.");
      }

      if (user.wallet_verified === true) {
        throw new Error("Akun ini sudah terikat pada wallet verified lain.");
      }
      if (payment.status !== "pending") {
        throw new Error("Permintaan pembayaran tidak lagi berstatus pending.");
      }
      if (rawAddress(user.wallet_address || "") !== rawAddress(payment.wallet_address)) {
        throw new Error("Wallet akun berubah. Buat permintaan verifikasi baru.");
      }
      const txHash = await findPaymentTransaction(payment);
      if (!txHash) {
        const expiresAt = new Date(payment.expires_at).getTime();
        if (Number.isFinite(expiresAt) && Date.now() > expiresAt) {
          const { error: expireError } = await supabase
            .from("wallet_verification_payments")
            .update({ status: "rejected" })
            .eq("id", payment.id)
            .eq("status", "pending");
          if (expireError) throw expireError;
          return json({
            success: false,
            pending: false,
            expired: true,
            message: "Verification request expired. Please start a new request.",
          }, 410);
        }
        return json({ success: false, pending: true, message: "Transaksi belum ditemukan atau belum final. Tunggu sebentar lalu periksa kembali." }, 202);
      }
      const { data: confirmed, error: confirmError } = await supabase.rpc("confirm_wallet_verification", {
        p_payment_id: payment.id,
        p_transaction_hash: txHash,
      });
      if (confirmError) throw new Error("Gagal mengesahkan verifikasi wallet: " + confirmError.message);
      if (!confirmed?.success) throw new Error(confirmed?.error || "Verifikasi wallet belum dapat disahkan");
      const latest = await getUser(telegramId);
      const wallet = await refreshUserBalance(latest);
      return json({
        success: true,
        wallet_verified: true,
        transaction_hash: txHash,
        wallet,
        message: "Pembayaran terverifikasi. Wallet DCX berhasil diaktifkan.",
      });
    }

    if (action === "refresh_balance") {
      const wallet = await refreshUserBalance(user);
      return json({ success: true, wallet });
    }

    return json({ success: false, error: "Action tidak dikenal" }, 400);
  } catch (error) {
    console.error("WALLET API ERROR:", error);
    return json({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }, 400);
  }
});
