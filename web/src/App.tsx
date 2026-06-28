import "./App.css";
import { LoginBar } from "./components/LoginBar.tsx";
import { MatchList } from "./components/MatchList.tsx";

export default function App() {
  return (
    <div className="app">
      <LoginBar />
      <MatchList />
    </div>
  );
}
