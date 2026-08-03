import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Home } from "./routes/Home";
import { Login } from "./routes/Login";
import { Product } from "./routes/Product";
import { Register } from "./routes/Register";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/products/:id", element: <Product /> },
      { path: "/login", element: <Login /> },
      { path: "/register", element: <Register /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
