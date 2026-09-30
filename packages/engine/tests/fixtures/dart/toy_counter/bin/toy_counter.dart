import 'package:toy_counter/toy_counter.dart' as toy;

void main(List<String> arguments) {
  final counter = toy.Counter.parse(arguments.isEmpty ? '1' : arguments.first);
  toy.stepMany(counter, 2);
  print(counter.describe());
  print(toy.labels(null).join(', '));
}
