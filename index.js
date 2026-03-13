import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
    res.send("Whop + Shopify backend running");
    });

    app.listen(3000, () => {
        console.log("Server running on port 3000");
        });
