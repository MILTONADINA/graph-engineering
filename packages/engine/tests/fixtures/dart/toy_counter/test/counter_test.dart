import 'package:toy_counter/toy_counter.dart';

/// Fails with [message] unless [condition] holds.
void check(bool condition, String message) {
  if (!condition) throw StateError(message);
}

void main() {
  final counter = Counter.startingAt(maxCount - 1)..increment();
  counter.increment();
  check(counter.value == maxCount, 'stops at the largest value');
  check(counter.isFull, 'reports a full counter');
  check(clampCount(-3, 5) == 0, 'never goes below zero');
  check(Counter.parse(' 7 ').value == 7, 'parses trimmed text');
}
