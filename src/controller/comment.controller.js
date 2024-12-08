"use strict";

const { catchAsync } = require("../helpers");
const { SuccessResponse } = require("../utils/SuccessResponse");
const {
  createComment,
  getCommentsByParentId,
  getCommentsByProductId,
  getCommentById,
  deleteComments,
} = require("./../services/comment.service");

class CommentController {
  createComment = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Comment created successfully",
      metadata: await createComment(req.body),
    }).send(res);
  });

  getCommentsByProduct = catchAsync(async (req, res) => {
    const comments = await getCommentsByProductId(req.query);
    return new SuccessResponse({
      message: "Comments by product retrieved successfully",
      metadata: {
        comments,
        length: comments.length,
      },
    }).send(res);
  });

  getCommentById = catchAsync(async (req, res) => {
    console.log("getCommentById", req.params);
    return new SuccessResponse({
      message: "Comment retrieved successfully",
      metadata: await getCommentById(req.params),
    }).send(res);
  });

  getNestedComment = catchAsync(async (req, res) => {
    console.log("getNestedComment", req.query);
    const comments = await getCommentsByParentId(req.query);
    return new SuccessResponse({
      message: "Nested comments retrieved successfully",
      metadata: {
        comments,
        length: comments.length,
      },
    }).send(res);
  });

  deleteComments = catchAsync(async (req, res) => {
    return new SuccessResponse({
      message: "Comment deleted successfully",
      metadata: await deleteComments(req.query),
    }).send(res);
  });
}

module.exports = new CommentController();
