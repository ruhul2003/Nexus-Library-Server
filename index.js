const express = require("express");
const cors = require("cors"); 
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb"); 
require("dotenv").config();
// Missing import


const app = express();
const port = process.env.PORT || 5000;

app.use(cors()); 
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

        // Build a dynamic document node entry
        const feeCalculated = amountTotal ? amountTotal / 100 : 2.5; // Convert cents to dollars
        const orderRecord = {
          stripeSessionId: sessionId,
          userEmail: customerEmail,
          title: "Requested Library Volume Asset", // In production, pass book meta via metadata
          fee: feeCalculated,
          date: new Date().toISOString().split("T")[0], // YYYY-MM-DD
          paymentStatus: "paid",
          status: "Pending", // Initial state: Awaiting librarian approval
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
        const { status } = req.body; // Expected strings: 'Dispatched', 'Delivered'

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

    // =========================================================================
    // E. FETCH ALL BOOKS FOR LIBRARIAN INVENTORY
    // =========================================================================
    app.get("/api/librarian/books", async (req, res) => {
      try {
        // Retrieves all books from the collection sorted by newest entry
        const results = await booksCollection
          .find()
          .sort({ _id: -1 })
          .toArray();
        res.send(results);
      } catch (error) {
        res
          .status(500)
          .send({
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
          status: "Pending Approval", // Hardcoded enforcement rule requirement
        };

        const result = await booksCollection.insertOne(newBookRecord);
        res.status(201).send({ success: true, bookId: result.insertedId });
      } catch (error) {
        res
          .status(500)
          .send({
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
        const { status } = req.body; // Expected strings: 'Published' or 'Unpublished'

        if (!ObjectId.isValid(id)) {
          return res
            .status(400)
            .send({ message: "Invalid document identification sequence." });
        }

        // Fetch target book item to check its status node constraints
        const targetedBook = await booksCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!targetedBook) {
          return res
            .status(404)
            .send({ message: "Book target entity not found." });
        }

        // Security Guardrail Rule Enforcement
        if (targetedBook.status === "Pending Approval") {
          return res
            .status(403)
            .send({
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
        res
          .status(500)
          .send({
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
        // Enforces visibility tracking parameters
        const query = { status: "Published" };
        
        const results = await booksCollection
          .find(query)
          .sort({ _id: -1 })
          .toArray();
          
        res.send(results);
      } catch (error) {
        res.status(500).send({ message: "Failed to retrieve public catalog.", error: error.message });
      }
    });

    // =========================================================================
    // I. FETCH SINGLE BOOK PROFILE BY OBJECT ID
    // =========================================================================
   // Make sure this is at the top of your file
const { ObjectId } = require('mongodb');

app.get("/api/books/:id", async (req, res) => {
  try {
    const id = req.params.id;

    let book;

    // Try ObjectId first (for real MongoDB _id)
    if (ObjectId.isValid(id)) {
      book = await booksCollection.findOne({ _id: new ObjectId(id) });
    } 
    // Fallback: Try as string/number (for your current test data)
    else {
      book = await booksCollection.findOne({ 
        $or: [
          { _id: id },           // if you stored string
          { id: parseInt(id) },  // if you have a numeric 'id' field
          { id: id }             // string id
        ]
      });
    }

    if (!book) {
      return res.status(404).json({ 
        message: "The requested book was not found." 
      });
    }

    res.json(book);
  } catch (error) {
    console.error(error);
    res.status(500).json({ 
      message: "Error fetching book", 
      error: error.message 
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