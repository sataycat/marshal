import { Board } from "./board/Board";
import { useBoard } from "./hooks/useBoard";

export function App() {
  const { tasks, status } = useBoard();
  return <Board tasks={tasks} status={status} />;
}
