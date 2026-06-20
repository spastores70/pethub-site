require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const Stripe  = require("stripe");
const { createClient } = require("@supabase/supabase-js");

// Strip UTF-8 BOM that PowerShell can inject into env vars
const env = (key) => (process.env[key] || "").replace(/^﻿/, "").trim();

const app    = express();
const stripe = Stripe(env("STRIPE_SECRET_KEY"));
const db     = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));

// ─── Middleware ────────────────────────────────────────────────────────────────
// Stripe webhook needs the raw body BEFORE express.json() parses it
app.use("/api/webhook", express.raw({ type: "application/json" }));
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ─── Admin auth middleware ─────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (token !== env("ADMIN_PASSWORD")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ─── CJ Dropshipping helpers ──────────────────────────────────────────────────
const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1";

async function getCJToken() {
  const res  = await fetch(`${CJ_BASE}/authentication/getAccessToken`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      email:    env("CJ_EMAIL"),
      password: env("CJ_API_KEY")
    })
  });
  const data = await res.json();
  if (!data.result) throw new Error("CJ auth failed: " + data.message);
  return data.data.accessToken;
}

async function cjRequest(path, options = {}) {
  const token = await getCJToken();
  const res = await fetch(`${CJ_BASE}${path}`, {
    ...options,
    headers: {
      "CJ-Access-Token": token,
      "Content-Type":    "application/json",
      ...options.headers
    }
  });
  return res.json();
}

// ─── POST /api/checkout ────────────────────────────────────────────────────────
// Creates a Stripe Checkout session and saves a pending order to Supabase.
// Cart items must include { name, price, cj_vid } — cj_vid is needed for fulfillment.
app.post("/api/checkout", async (req, res) => {
  try {
    const { customer, cart } = req.body;

    if (!cart || cart.length === 0) {
      return res.status(400).json({ error: "Cart is empty." });
    }

    const requiredFields = ["name", "email", "phone", "address", "city", "state", "zip"];
    for (const field of requiredFields) {
      if (!customer[field]) {
        return res.status(400).json({ error: `Missing customer field: ${field}` });
      }
    }

    const total = cart.reduce((sum, item) => sum + Number(item.price), 0);

    // Save pending order — status updated to "Paid" by webhook after payment
    const { data: order, error: dbErr } = await db
      .from("orders")
      .insert({
        customer_name:    customer.name,
        customer_email:   customer.email,
        customer_phone:   customer.phone,
        customer_address: customer.address,
        customer_city:    customer.city,
        customer_state:   customer.state,
        customer_zip:     customer.zip,
        items:            cart,
        total,
        status:           "Pending Payment"
      })
      .select()
      .single();

    if (dbErr) throw dbErr;

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode:                 "payment",
      customer_email:       customer.email,
      line_items: cart.map(item => ({
        price_data: {
          currency:     "usd",
          product_data: { name: item.name },
          unit_amount:  Math.round(Number(item.price) * 100)
        },
        quantity: 1
      })),
      metadata: {
        order_id: String(order.id)
      },
      success_url: `${env("SITE_URL")}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${env("SITE_URL")}/checkout.html`
    });

    // Store the Stripe session ID so the webhook can find the order
    await db
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", order.id);

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: "Checkout failed." });
  }
});

// ─── POST /api/webhook ────────────────────────────────────────────────────────
// Stripe sends payment confirmation here. Verifies signature, marks order paid,
// then auto-fulfills with CJ Dropshipping.
app.post("/api/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      env("STRIPE_WEBHOOK_SECRET")
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).json({ error: "Webhook signature failed." });
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const orderId = session.metadata.order_id;

    const { data: order } = await db
      .from("orders")
      .update({
        status:                 "Paid",
        stripe_payment_intent:  session.payment_intent
      })
      .eq("id", orderId)
      .select()
      .single();

    if (order) {
      await fulfillWithCJ(order);
    }
  }

  res.json({ received: true });
});

async function fulfillWithCJ(order) {
  // Only send items that have a CJ variant ID
  const products = order.items
    .filter(item => item.cj_vid)
    .map(item => ({
      vid:          item.cj_vid,
      quantity:     1,
      shippingName: "ordinary_insurance_shipping"
    }));

  if (products.length === 0) {
    await db.from("orders").update({ status: "Paid — No CJ Items" }).eq("id", order.id);
    return;
  }

  const payload = {
    orderNumber:          String(order.id),
    shippingCountry:      "US",
    shippingZip:          order.customer_zip,
    shippingPhone:        order.customer_phone,
    shippingCustomerName: order.customer_name,
    shippingAddress:      order.customer_address,
    shippingCity:         order.customer_city,
    shippingProvince:     order.customer_state,
    products
  };

  let cjOrderId = null;
  let newStatus  = "Fulfillment Failed";

  try {
    const cjRes = await cjRequest("/order/createOrder", {
      method: "POST",
      body:   JSON.stringify(payload)
    });

    if (cjRes.result) {
      cjOrderId = cjRes.data?.orderId;
      newStatus  = "Sent to Supplier";
    } else {
      console.error("CJ order error:", cjRes.message);
    }
  } catch (err) {
    console.error("CJ fulfillment exception:", err);
  }

  await db
    .from("orders")
    .update({ status: newStatus, supplier: "CJ Dropshipping", cj_order_id: cjOrderId })
    .eq("id", order.id);
}

// ─── GET /api/products ─────────────────────────────────────────────────────────
app.get("/api/products", async (req, res) => {
  const { data, error } = await db
    .from("products")
    .select("id, name, description, price, image, category, badge, cj_vid")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /api/import-product  (admin) ────────────────────────────────────────
// Pulls a product from CJ by pid and saves it to Supabase.
app.post("/api/import-product", adminOnly, async (req, res) => {
  const { pid, price, badge, category } = req.body;
  if (!pid)   return res.status(400).json({ error: "CJ product ID (pid) required." });
  if (!price) return res.status(400).json({ error: "Your selling price is required." });

  try {
    const cjData = await cjRequest(`/product/query?pid=${pid}`);
    if (!cjData.result || !cjData.data) {
      return res.status(400).json({ error: "CJ product not found: " + cjData.message });
    }

    const p          = cjData.data;
    const firstVid   = p.variants?.[0]?.vid || null;

    const { data, error } = await db
      .from("products")
      .upsert({
        cj_pid:      pid,
        cj_vid:      firstVid,
        name:        p.productNameEn,
        description: p.description || p.productUnit || "Premium pet product",
        price:       Number(price),
        cost:        Number(p.productPrice),
        image:       p.productImage,
        category:    category || "Pets",
        badge:       badge    || "New",
        active:      true
      }, { onConflict: "cj_pid" })
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error("Import error:", err);
    res.status(500).json({ error: "Import failed: " + err.message });
  }
});

// ─── GET /api/orders  (admin) ─────────────────────────────────────────────────
app.get("/api/orders", adminOnly, async (req, res) => {
  const { data, error } = await db
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── PATCH /api/orders/:id  (admin) ───────────────────────────────────────────
app.patch("/api/orders/:id", adminOnly, async (req, res) => {
  const { status, tracking } = req.body;
  const updates = {};
  if (status)   updates.status   = status;
  if (tracking) updates.tracking = tracking;

  const { data, error } = await db
    .from("orders")
    .update(updates)
    .eq("id", req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── POST /api/fulfill/:id  (admin) ───────────────────────────────────────────
// Manual fulfillment trigger for orders that weren't auto-fulfilled.
app.post("/api/fulfill/:id", adminOnly, async (req, res) => {
  const { data: order, error } = await db
    .from("orders")
    .select("*")
    .eq("id", req.params.id)
    .single();

  if (error || !order) return res.status(404).json({ error: "Order not found." });
  if (order.status !== "Paid") {
    return res.status(400).json({ error: "Order must be Paid before fulfillment." });
  }

  await fulfillWithCJ(order);

  const { data: updated } = await db
    .from("orders")
    .select("*")
    .eq("id", req.params.id)
    .single();

  res.json(updated);
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 4242;
  app.listen(PORT, () => console.log(`Petshub server running on port ${PORT}`));
}

module.exports = app;
