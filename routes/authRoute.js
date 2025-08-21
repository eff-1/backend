const express = require("express");
const db = require("../db");

const route = express.Router();

route.post("/signup", (req, res)=>{
    const {username, password} = req.body;
    const query = "INSERT INTO users2 (username, password) VALUE(?, ?)";
    db.query(query, [username, password], (err, result)=>{
        if(err.code === "ER_DUP_ENTRY") return res.status(400).json({error:"Username already exist!"});
         if(err) return res.status(500).json({error:err.message});
        res.status(201).json({id:result.insertId});
    });
});
route.post("/login", (req, res) => {
    const {username, password} = req.body;
    const query = "SELECT * FROM users2 WHERE username = ?";
    db.query(query, [username], (err, result) => {
        if (err) return res.status(500).json({error: err.message});
        if (result.length === 0) return res.status(401).json({error: "Incorrect username or password"});

        const user = result[0];
        // If you store password in plain text (not recommended), compare directly:
        if (user.password !== password) {
            return res.status(401).json({error: "Incorrect username or password"});
        }

        res.json({user: {id: user.id, username: user.username}});
    });
});

module.exports = route;