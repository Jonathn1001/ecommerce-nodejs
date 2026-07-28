# 🛒 E-Commerce Backend API

<div align="center">

![Node.js](https://img.shields.io/badge/Node.js-43853D?style=for-the-badge&logo=node.js&logoColor=white)
![Express.js](https://img.shields.io/badge/Express.js-404D59?style=for-the-badge)
![MongoDB](https://img.shields.io/badge/MongoDB-4EA94B?style=for-the-badge&logo=mongodb&logoColor=white)
![JWT](https://img.shields.io/badge/JWT-black?style=for-the-badge&logo=JSON%20web%20tokens)
![Redis](https://img.shields.io/badge/redis-%23DD0031.svg?style=for-the-badge&logo=redis&logoColor=white)

</div>

A robust and scalable e-commerce backend API built with Node.js, designed to handle all aspects of an online store including product management, user authentication, shopping cart functionality, order processing, and more.

## 📋 Description

This project serves as a comprehensive backend solution for e-commerce applications, providing RESTful APIs for:

- 👤 **User Management**: Authentication and authorization with JWT tokens
- 📦 **Product Catalog**: Product creation, management, and categorization (Electronics, Clothing, Furniture, Motorbike)
- 🛍️ **Shopping Cart**: Add, update, remove products from cart
- 💰 **Discount System**: Create and manage discount codes with various rules
- 📋 **Order Management**: Complete checkout process with order tracking
- 📊 **Inventory Management**: Stock tracking and reservation system
- 💬 **Comment System**: Product reviews and nested comments
- 🔔 **Notification System**: Real-time notifications for various events
- 📁 **File Upload**: Image upload to Cloudinary and AWS S3
- 🚀 **Message Queuing**: RabbitMQ and Kafka integration for async processing

## ⚡ Tech Stack

### 🏗️ Core Technologies

| Technology     | Badge                                                                                           | Purpose          |
| -------------- | ----------------------------------------------------------------------------------------------- | ---------------- |
| **Node.js**    | ![Node.js](https://img.shields.io/badge/Node.js-43853D?style=flat&logo=node.js&logoColor=white) | Server runtime   |
| **Express.js** | ![Express.js](https://img.shields.io/badge/Express.js-404D59?style=flat)                        | Web framework    |
| **MongoDB**    | ![MongoDB](https://img.shields.io/badge/MongoDB-4EA94B?style=flat&logo=mongodb&logoColor=white) | NoSQL database   |
| **Mongoose**   | ![Mongoose](https://img.shields.io/badge/Mongoose-880000?style=flat)                            | ODM for MongoDB  |
| **JWT**        | ![JWT](https://img.shields.io/badge/JWT-black?style=flat&logo=JSON%20web%20tokens)              | Authentication   |
| **bcrypt**     | ![bcrypt](https://img.shields.io/badge/bcrypt-2E8B57?style=flat)                                | Password hashing |

### ☁️ Cloud Services

| Service           | Badge                                                                                                         | Purpose        |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | -------------- |
| **Cloudinary**    | ![Cloudinary](https://img.shields.io/badge/Cloudinary-3448C5?style=flat&logo=Cloudinary&logoColor=white)      | Image storage  |
| **AWS S3**        | ![AWS S3](https://img.shields.io/badge/AWS%20S3-FF9900?style=flat&logo=amazons3&logoColor=white)              | File storage   |
| **MongoDB Atlas** | ![MongoDB Atlas](https://img.shields.io/badge/MongoDB%20Atlas-4EA94B?style=flat&logo=mongodb&logoColor=white) | Cloud database |

### 🔄 Message Queuing & Caching

| Technology       | Badge                                                                                              | Purpose             |
| ---------------- | -------------------------------------------------------------------------------------------------- | ------------------- |
| **RabbitMQ**     | ![RabbitMQ](https://img.shields.io/badge/RabbitMQ-FF6600?style=flat&logo=rabbitmq&logoColor=white) | Message broker      |
| **Apache Kafka** | ![Kafka](https://img.shields.io/badge/Apache%20Kafka-000?style=flat&logo=apachekafka)              | Event streaming     |
| **Redis**        | ![Redis](https://img.shields.io/badge/redis-%23DD0031.svg?style=flat&logo=redis&logoColor=white)   | Distributed locking |

### 🛠️ Development Tools

| Tool        | Badge                                                                               | Purpose               |
| ----------- | ----------------------------------------------------------------------------------- | --------------------- |
| **PM2**     | ![PM2](https://img.shields.io/badge/PM2-2B037A?style=flat&logo=pm2&logoColor=white) | Process manager       |
| **dotenv**  | ![dotenv](https://img.shields.io/badge/dotenv-ECD53F?style=flat)                    | Environment variables |
| **Multer**  | ![Multer](https://img.shields.io/badge/Multer-FF6600?style=flat)                    | File upload           |
| **Winston** | ![Winston](https://img.shields.io/badge/Winston-231F20?style=flat)                  | Logging               |

### 🔒 Security & Middleware

| Technology        | Badge                                                                         | Purpose              |
| ----------------- | ----------------------------------------------------------------------------- | -------------------- |
| **Helmet.js**     | ![Helmet](https://img.shields.io/badge/Helmet-000000?style=flat)              | Security headers     |
| **Compression**   | ![Compression](https://img.shields.io/badge/Compression-blue?style=flat)      | Response compression |
| **CORS**          | ![CORS](https://img.shields.io/badge/CORS-green?style=flat)                   | Cross-origin support |
| **Rate Limiting** | ![Rate Limiting](https://img.shields.io/badge/Rate%20Limiting-red?style=flat) | API protection       |

### 🧰 Utilities

| Utility        | Badge                                                                                        | Purpose             |
| -------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| **Slugify**    | ![Slugify](https://img.shields.io/badge/Slugify-yellow?style=flat)                           | URL slug generation |
| **Lodash**     | ![Lodash](https://img.shields.io/badge/Lodash-3492FF?style=flat&logo=lodash&logoColor=white) | Data manipulation   |
| **Date Utils** | ![Date](https://img.shields.io/badge/Date%20Utils-purple?style=flat)                         | Date handling       |

## 🏛️ Architecture Features

### 🎨 Design Patterns

- 🏭 **Factory Pattern**: Product creation system
- 📚 **Repository Pattern**: Data access layer abstraction
- ⚙️ **Service Layer**: Business logic separation
- 🏗️ **MVC Architecture**: Clean separation of concerns

### 🗄️ Database Design

- 🔄 **Product Variants**: Support for different product types (Electronics, Clothing, etc.)
- 📝 **Flexible Schema**: Mixed type attributes for product specifications
- ⚡ **Optimized Queries**: Proper indexing and lean queries
- 📊 **Aggregation Pipelines**: Complex data retrieval operations

### 🚀 Advanced Features

- 🔒 **Distributed Locking**: Redis-based inventory reservation
- 🎯 **Event-Driven Architecture**: RabbitMQ pub/sub patterns
- 🔧 **Microservice Ready**: Modular service architecture
- 🛡️ **Error Handling**: Comprehensive error management system
- 📌 **API Versioning**: Version-controlled endpoints
- 🌍 **Environment Configuration**: Multi-environment support (dev, ci, production)

## 📁 Project Structure

```
src/
├── 🚀 app.js                 # Express application setup
├── 🔐 auth/                  # Authentication & authorization
├── ⚙️ configs/               # Configuration files
├── 📌 constants/             # Application constants
├── 🎮 controller/            # Route controllers
├── 🗄️ dbs/                  # Database connection
├── 🤝 helpers/              # Utility helpers
├── 🔑 keys/                 # API keys management
├── 📝 loggers/              # Logging configuration
├── 🛡️ middlewares/          # Custom middlewares
├── 📊 models/               # Database models & repositories
├── 🛣️ routes/               # API route definitions
├── ⚙️ services/             # Business logic services
├── 🧪 tests/                # Test implementations
├── 📁 upload/               # File upload handling
└── 🧰 utils/                # Utility functions
```

## 🌐 API Endpoints

### 🔐 Authentication

- `POST /api/v1/auth/signup` - 📝 User registration
- `POST /api/v1/auth/signin` - 🔑 User login

### 📦 Products

- `GET /api/v1/product/all` - 📋 Get all products
- `POST /api/v1/product/create` - ➕ Create new product
- `GET /api/v1/product/search/:keyword` - 🔍 Search products

### 🛍️ Cart & Checkout

- `POST /api/v1/cart/add` - ➕ Add product to cart
- `GET /api/v1/cart/list/:user_id` - 📋 Get user cart
- `POST /api/v1/checkout/preview` - 👁️ Preview checkout

### 💰 Discounts

- `POST /api/v1/discount/create` - ➕ Create discount code
- `GET /api/v1/discount/amount` - 🧮 Calculate discount amount

## 🚀 Getting Started

1. **📥 Clone the repository**
2. **📦 Install dependencies**: `npm install`
3. **⚙️ Set up environment variables** in `.env.dev`, `.env.ci`
4. **🔄 Start services**: MongoDB, Redis, RabbitMQ
5. **▶️ Run the application**: `npm run dev`

## 🌍 Environment Support

- **🔧 Development**: `.env.dev`
- **🔄 CI/CD**: `.env.ci`
- **🚀 Production**: PM2 process management

---

<div align="center">

**🎯 This backend API is designed to scale and can easily integrate with any frontend framework (React, Vue.js, Angular) or mobile application.**

[![Made with ❤️](https://img.shields.io/badge/Made%20with-❤️-red.svg)](https://github.com/yourusername)
[![Node.js Version](https://img.shields.io/badge/Node.js-v18+-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

</div>
