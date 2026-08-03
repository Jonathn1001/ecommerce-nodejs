import { createBrowserRouter, RouterProvider } from "react-router";
import { Layout } from "./components/Layout";
import { Home } from "./routes/Home";
import { Product } from "./routes/Product";

const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/products/:id", element: <Product /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
