part of '../toy_counter.dart';

/// Describes [counter] for a person, naming a full counter.
String formatCount(Counter counter) {
  final (value, full) = counter.snapshot();
  return full ? 'full at $value' : 'count $value';
}
