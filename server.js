const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();

const serviceAccount = require("./serviceAccountKey.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
const app = express();

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Tohon Backend Running 🚀",
  });
});

// 1. INITIALIZE PAYMENT
app.post("/api/payment/initialize", async (req, res) => {
  try {
    const { email, amount, items, shippingAddress } = req.body;

    const response = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email,
        amount: Math.round(amount * 100), // Ensures absolute integer kobo parsing
        currency: "NGN",
        callback_url: "http://localhost:5173/payment-success",
        reference: `tohon_${Date.now()}`, 
        metadata: {
          custom_fields: [
            {
              display_name: "Cart Items",
              variable_name: "cart_items",
              value: JSON.stringify(items) // Stringified to prevent metadata strip
            },
            {
              display_name: "Shipping Address",
              variable_name: "shipping_address",
              value: JSON.stringify(shippingAddress)
            }
          ]
        },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    res.status(200).json(response.data);
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Payment initialization failed",
    });
  }
});

// 2. VERIFY PAYMENT
app.post("/api/payment/verify", async (req, res) => {
  try {
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ success: false, message: "No reference provided" });
    }

    const response = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );

    const payment = response.data.data;

    if (payment.status !== "success") {
      return res.status(400).json({
        success: false,
        message: "Payment not successful",
      });
    }

    // Check if duplicate order execution occurred
    const existingOrder = await db
      .collection("orders")
      .where("reference", "==", reference)
      .limit(1)
      .get();

    if (!existingOrder.empty) {
      return res.status(200).json({
        success: true,
        message: "Order already processed",
      });
    }

    // TARGET AND PARSE STRINGIFIED METADATA IN THE VERIFY SCOPE
    const customFields = payment.metadata?.custom_fields || [];
    const itemsField = customFields.find(field => field.variable_name === "cart_items");
    const shippingField = customFields.find(field => field.variable_name === "shipping_address");

    let items = [];
    if (itemsField && itemsField.value) {
      try {
        items = JSON.parse(itemsField.value);
      } catch (e) {
        console.error("JSON parsing error for items:", e);
      }
    }

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No items found or invalid custom metadata layout",
      });
    }

    let shippingAddress = {};
    if (shippingField && shippingField.value) {
      try {
        shippingAddress = JSON.parse(shippingField.value);
      } catch (e) {
        console.error("JSON parsing error for shipping address:", e);
      }
    }

    // Batch update product counts in Firestore safely
    for (const item of items) {
      const qty = Number(item.quantity);
      if (!item.id || !qty) continue;

      await db.collection("products").doc(item.id).update({
        stock: admin.firestore.FieldValue.increment(-qty),
        soldCount: admin.firestore.FieldValue.increment(qty)
      });
    }

    // Append standard payload back to Firestore records
    await db.collection("orders").add({
      reference,
      email: payment.customer.email,
      amount: payment.amount / 100, 
      currency: payment.currency,
      status: "paid",
      items,
      shippingAddress,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      message: "Payment verified successfully",
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Payment verification failed",
    });
  }
});

// 3. GET PRODUCTS
app.get("/api/products", async (req, res) => {
  try {
    const snapshot = await db.collection("products").get();
    const products = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.status(200).json(products);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch products" });
  }
});

// 4. GET ORDERS
app.get("/api/orders", async (req, res) => {
  try {
    const snapshot = await db
      .collection("orders")
      .orderBy("createdAt", "desc")
      .get();

    const orders = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));
    res.status(200).json(orders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});