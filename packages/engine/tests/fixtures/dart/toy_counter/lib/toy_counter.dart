import 'dart:math' as math;

export 'src/labels.dart' show labels;

part 'src/counter_format.dart';

/// The largest value a counter reaches.
const int maxCount = 99;

/// Keeps [value] between zero and [limit].
int clampCount(int value, int limit) => math.min(math.max(value, 0), limit);

/// Increments [counter] [times] times and returns it.
Counter stepMany(Counter counter, int times) {
  for (var step = 0; step < times; step++) {
    counter.increment();
  }
  return counter;
}

/// A counter that stays between zero and [maxCount].
class Counter {
  Counter([this.value = 0]);

  Counter.startingAt(int start) : value = clampCount(start, maxCount);

  factory Counter.fromText(String text) => Counter.startingAt(int.parse(text));

  int value;

  static Counter parse(String text) => Counter.fromText(text.trim());

  void increment() {
    value = clampCount(value + 1, maxCount);
  }

  (int, bool) snapshot() => (value, value == maxCount);
}

/// Reporting helpers for any [Counter].
extension CounterReport on Counter {
  String describe() => formatCount(this);

  bool get isFull => switch (snapshot()) {
    (_, true) => true,
    _ => false,
  };
}
