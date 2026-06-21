require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

// 💡 FIX 1: Restored missing Stripe initialization
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// Middleware Configuration
app.use(
  cors({
    origin: "http://localhost:3000", // Allows your Next.js frontend to securely pass credentials
    credentials: true,
  }),
);
app.use(express.json());

const uri = process.env.MONGODB_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const database = client.db("Library_Nexus_db");
    const booksCollection = database.collection("Books");
    const ordersCollection = database.collection("Orders");

    // =========================================================================
    // 💡 FIX 2: Re-inserted the missing Stripe Checkout Endpoint
    // =========================================================================
    app.post("/api/checkout_sessions", async (req, res) => {
      try {
        if (!req.body) {
          return res
            .status(400)
            .json({ message: "Request body is completely missing." });
        }

        const { cartItems } = req.body;

        if (!cartItems || cartItems.length === 0) {
          return res
            .status(400)
            .json({
              message: "No items provided for checkout inside cartItems.",
            });
        }

        const lineItems = cartItems.map((item) => {
          const numericPrice =
            typeof item.price === "string"
              ? parseFloat(item.price)
              : item.price;
          const unitAmountInCents = Math.round(numericPrice * 100);

          if (isNaN(unitAmountInCents) || unitAmountInCents <= 0) {
            throw new Error(
              `Invalid price calculation for item: ${item.title}`,
            );
          }

          return {
            price_data: {
              currency: "usd",
              product_data: {
                name: item.title,
              },
              unit_amount: unitAmountInCents,
            },
            quantity: item.quantity || 1,
          };
        });

        const frontendUrl =
          process.env.BETTER_AUTH_URL || "http://localhost:3000";

        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          line_items: lineItems,
          mode: "payment",
          success_url: `${frontendUrl}/books/success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${frontendUrl}/books`,
          metadata: {
            bookId: cartItems[0].id,
          },
        });

        res.json({ success: true, url: session.url });
      } catch (error) {
        console.error("Stripe Session Creation Failure:", error);
        res.status(500).json({
          message: "Failed to initialize Stripe checkout session processing.",
          error: error.message,
        });
      }
    });

    // =========================================================================
    // A. CONFIRM & COMMIT ORDER FROM SUCCESS PAGE
    // =========================================================================
    app.post("/api/orders/confirm", async (req, res) => {
      try {
        const { sessionId, customerEmail, amountTotal } = req.body;

        if (!sessionId) {
          return res
            .status(400)
            .send({ message: "Session ID parameters required." });
        }

        const existingOrder = await ordersCollection.findOne({
          stripeSessionId: sessionId,
        });
        if (existingOrder) {
          return res.send({
            message: "Order record already committed.",
            orderId: existingOrder._id,
          });
        }

        const feeCalculated = amountTotal ? amountTotal / 100 : 2.5;
        const orderRecord = {
          stripeSessionId: sessionId,
          userEmail: customerEmail,
          title: "Requested Library Volume Asset",
          fee: feeCalculated,
          date: new Date().toISOString().split("T")[0],
          paymentStatus: "paid",
          status: "Pending",
        };

        const result = await ordersCollection.insertOne(orderRecord);
        res.status(201).send({ success: true, orderId: result.insertedId });
      } catch (error) {
        res.status(500).send({
          message: "Failed to persist ledger record.",
          error: error.message,
        });
      }
    });

    // =========================================================================
    // B. FETCH READER-SPECIFIC LOG ENTRIES
    // =========================================================================
    app.get("/api/orders/my-orders/:email", async (req, res) => {
      try {
        const email = req.params.email;
        const results = await ordersCollection
          .find({ userEmail: email })
          .sort({ _id: -1 })
          .toArray();
        res.send(results);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed fetching reader records", error });
      }
    });

    // =========================================================================
    // C. FETCH ALL ORDERS FOR LIBRARIAN
    // =========================================================================
    app.get("/api/librarian/orders", async (req, res) => {
      try {
        const results = await ordersCollection
          .find()
          .sort({ _id: -1 })
          .toArray();
        res.send(results);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Failed loading logistics records", error });
      }
    });

    // =========================================================================
    // D. MUTATE SYSTEM STATUS (Librarian State Management Router)
    // =========================================================================
    app.patch("/api/orders/:id/status", async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res.status(400).send({
            message: "Invalid target document structural identity code.",
          });
        }

        const result = await ordersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: status } },
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({
          message: "State shift transition cycle processing halted.",
          error,
        });
      }
    });

    // Deletion API

    // আপনার ব্যাকএন্ডের index.js এ এই ডিলিট রুটটি যোগ করতে পারেন:
    app.delete("/api/books/:id", async (req, res) => {
      try {
        const id = req.params.id;
        if (!ObjectId.isValid(id)) {
          return res.status(400).send({ message: "Invalid ID sequence" });
        }
        const result = await booksCollection.deleteOne({
          _id: new ObjectId(id),
        });
        res.send(result);
      } catch (error) {
        res
          .status(500)
          .send({ message: "Delete action failed", error: error.message });
      }
    });

    // =========================================================================
    // E. FETCH ALL BOOKS FOR LIBRARIAN INVENTORY
    // =========================================================================
    app.get("/api/librarian/books", async (req, res) => {
      try {
        const results = await booksCollection
          .find()
          .sort({ _id: -1 })
          .toArray();
        res.send(results);
      } catch (error) {
        res.status(500).send({
          message: "Failed loading librarian inventory data.",
          error: error.message,
        });
      }
    });

    // =========================================================================
    // F. INGEST NEW BOOK VOLUME ASSET (With Strict Defaults)
    // =========================================================================
    app.post("/api/books", async (req, res) => {
      try {
        const { title, author, description, fee, category, imageUrl } =
          req.body;

        const newBookRecord = {
          title,
          author,
          description,
          fee: parseFloat(fee) || 0,
          category,
          imageUrl,
          status: "Pending Approval",
        };

        const result = await booksCollection.insertOne(newBookRecord);
        res.status(201).send({ success: true, bookId: result.insertedId });
      } catch (error) {
        res.status(500).send({
          message: "Failed to persist book creation into storage ledger.",
          error: error.message,
        });
      }
    });

    // =========================================================================
    // G. TOGGLE BOOK VISIBILITY (Published / Unpublished Guardrail)
    // =========================================================================
    app.patch("/api/books/:id/visibility", async (req, res) => {
      try {
        const id = req.params.id;
        const { status } = req.body;

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ message: "Invalid document identification sequence." });
        }

        const targetedBook = await booksCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!targetedBook) {
          return res
            .status(404)
            .send({ message: "Book target entity not found." });
        }

        if (targetedBook.status === "Pending Approval") {
          return res.status(403).send({
            message:
              "Publishing Power Denied: Cannot modify a book awaiting Admin approval.",
          });
        }

        const result = await booksCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status: status } },
        );
        res.send(result);
      } catch (error) {
        res.status(500).send({
          message: "Visibility state toggle halted.",
          error: error.message,
        });
      }
    });

    // =========================================================================
    // H. FETCH PUBLIC CATALOG (Only Approved & Published Books)
    // =========================================================================
    app.get("/api/books", async (req, res) => {
      try {
        const query = { status: "Published" };
        const results = await booksCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();

        res.send(results);
      } catch (error) {
        res
          .status(500)
          .send({
            message: "Failed to retrieve public catalog.",
            error: error.message,
          });
      }
    });

    // =========================================================================
    // I. FETCH SINGLE BOOK PROFILE BY OBJECT ID
    // =========================================================================
    app.get("/api/books/:id", async (req, res) => {
      try {
        const id = req.params.id;
        let book;

        if (ObjectId.isValid(id)) {
          book = await booksCollection.findOne({ _id: new ObjectId(id) });
        } else {
          book = await booksCollection.findOne({
            $or: [{ _id: id }, { id: parseInt(id) }, { id: id }],
          });
        }

        if (!book) {
          return res.status(404).json({
            message: "The requested book was not found.",
          });
        }

        res.json(book);
      } catch (error) {
        console.error(error);
        res.status(500).json({
          message: "Error fetching book",
          error: error.message,
        });
      }
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    console.error("Database connection error:", error);
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Library Nexus server running perfectly!");
});

app.listen(port, () => {
  console.log(`Library Nexus backend streaming live on port ${port}`);
});
