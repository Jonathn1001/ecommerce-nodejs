import { createBrowserRouter, RouterProvider } from "react-router";
import { Home } from "./routes/Home";

const router = createBrowserRouter([{ path: "/", element: <Home /> }]);

export function App() {
  return <RouterProvider router={router} />;
}
