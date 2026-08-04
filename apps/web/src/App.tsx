import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { RequireAuth } from "./components/RequireAuth";
import { Cart } from "./routes/Cart";
import { Home } from "./routes/Home";
import { Login } from "./routes/Login";
import { Order } from "./routes/Order";
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
      {
        path: "/cart",
        element: (
          <RequireAuth>
            <Cart />
          </RequireAuth>
        ),
      },
      {
        path: "/orders/:id",
        element: (
          <RequireAuth>
            <Order />
          </RequireAuth>
        ),
      },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
