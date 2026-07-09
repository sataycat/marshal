import { Board } from "./board/Board";
import { BoardProvider } from "./board/BoardContext";

export function App() {
  return (
    <BoardProvider>
      <Board />
    </BoardProvider>
  );
}
