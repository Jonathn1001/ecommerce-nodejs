"use strict";

const express = require("express");
const commentController = require("../../controller/comment.controller");
const { apiKey, authentication } = require("../../auth/checkAuth");
const router = express.Router();

router.use(apiKey);
router.use(authentication);

router.post("/create", commentController.createComment);
router.get("/product", commentController.getCommentsByProduct);
router.get("/nested", commentController.getNestedComment);
router.get("/:comment_id", commentController.getCommentById);
router.delete("/", commentController.deleteComments);

module.exports = router;
