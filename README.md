markdown

# E-Commerce Node.js

A full-stack e-commerce web application built with Node.js. Users can browse products, add to cart, place orders, and complete secure payments. Includes user authentication, admin panel for product management, and order tracking.

## Features
- User registration & login
- Product browsing with filters
- Shopping cart & wishlist
- Secure checkout with Stripe
- Admin dashboard (add/edit/delete products)
- Order management & email confirmations
- Responsive design with Pug templates

## Tech Stack
- **Backend**: Node.js, Express.js
- **Database**: MongoDB + Mongoose
- **Templating**: Pug
- **Authentication**: JWT + bcrypt
- **Payments**: Stripe
- **Email**: Nodemailer (SendGrid/Mailtrap)
- **File Uploads**: Multer
- **Other**: slugify, dotenv, express-rate-limit, helmet, etc.

## How to Run Locally

### Prerequisites
- Node.js (v14 or higher)
- MongoDB (local or Atlas)
- Stripe account (for payments)
- SendGrid/Mailtrap (for emails)

### Installation
```bash
git clone https://github.com/Jonathn1001/ecommerce-nodejs.git
cd ecommerce-nodejs
npm install

Environment VariablesCopy .env.example to .env and fill in your credentials:bash

cp .env.example .env

Required variables:

DATABASE=your_mongo_uri
DATABASE_PASSWORD=your_password
JWT_SECRET=your_jwt_secret
STRIPE_SECRET_KEY=your_stripe_key
SENDGRID_USERNAME=...
SENDGRID_PASSWORD=...
EMAIL_FROM=no-reply@ecommerce.com

Start the AppDevelopment:bash

npm run dev

Production:bash

npm run start:prod

Visit http://localhost:3000Live Demo(If deployed) Check the deployed version on Heroku: [link here]Admin AccessEmail: admin@example.com
Password: admin123

Enjoy exploring and feel free to contribute!

