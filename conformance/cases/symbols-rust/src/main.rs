struct Point {
    x: i32,
}

impl Point {
    fn new(x: i32) -> Self {
        let c = '{';
        Point { x }
    }
}

fn main<'a>() {
    let p = Point::new(1);
}
